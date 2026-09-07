import { PingPong, type FloatFormat } from './fbo.ts';
import { createProgram, Uniforms, type ShaderModule } from './program.ts';

/**
 * The bloom halo: a whole frame rendered small, thresholded, and blurred.
 *
 * WHY IT IS SIZED ABSOLUTELY. Post-processing and byte-identical tiled export
 * are in real conflict — a spatial kernel reads neighbours, so a tile cannot be
 * rendered independently. Apron tiles would fix it at a cost that grows with
 * the kernel, and a bloom kernel is deliberately huge. The way out is the move
 * this repo already made for simulation grids: fix the buffer's size in TEXELS
 * ON THE SHORT SIDE and build it once for the whole frame before any tile. Then
 * nothing a tile can observe changes with the tiling, and `test/export.test.ts`
 * keeps passing without being weakened.
 *
 * It costs an approximation and the approximation is free. Bloom is a wide,
 * low-frequency halo; computing it from a 256px render and sampling it
 * bilinearly at 4000px is what a mip pyramid does, for the same reason. The
 * bonus is that the halo is then identical at every output size — the same
 * property `basics/aa` exists for, reached from the other direction. A bloom
 * measured in output pixels would be a different picture on a print.
 *
 * The source render is a plain draw of the artwork at that size, outside the
 * accumulator, so it is a pure function of (seed, frame, aspect, size) like
 * everything else here.
 */
export class Bloom {
  private gl: WebGL2RenderingContext;
  private format: FloatFormat;
  /** The low-resolution render of the frame, and the ping-pong for the blur. */
  private src: PingPong;
  private program: WebGLProgram | null = null;
  private uniforms: Uniforms | null = null;
  private vao: WebGLVertexArrayObject | null;
  private built = false;

  /** Texels on the short side. The long side follows the output's aspect. */
  size = 256;
  /** Blur iterations; each doubles the stride, so reach grows as 2^n. */
  iterations = 4;
  /**
   * Samples per pixel for the source render.
   *
   * More than one because thresholding a noisy image keeps whichever samples
   * happened to land above the line, which biases the halo brighter and makes
   * it flicker frame to frame. Cheap here: the source is a couple of hundred
   * pixels on a side.
   */
  spp = 8;

  constructor(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject | null) {
    this.gl = gl;
    this.vao = vao;
    this.src = new PingPong(gl);
    this.format = this.src.format;
  }

  setShader(mod: ShaderModule): void {
    const next = createProgram(this.gl, mod);
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = next;
    this.uniforms = new Uniforms(this.gl, next);
  }

  get ready(): boolean {
    return this.program !== null && this.format.usable;
  }

  /** The blurred halo, or null until `build` has run for this frame. */
  get texture(): WebGLTexture | null {
    return this.built ? this.src.read.tex : null;
  }

  /** Aspect from the OUTPUT, size from `this.size`. Same rule as a pass grid. */
  resize(fullW: number, fullH: number): void {
    const short = Math.max(1, Math.min(fullW, fullH));
    const w = Math.max(4, Math.round((this.size * fullW) / short));
    const h = Math.max(4, Math.round((this.size * fullH) / short));
    if (this.src.resize(w, h)) this.built = false;
  }

  /** Throw away the halo; the next present must not use a stale one. */
  invalidate(): void {
    this.built = false;
  }

  /**
   * Build the halo for the current frame.
   *
   * `drawFrame` renders the artwork once into the framebuffer it is handed, at
   * the size it is handed — the caller owns the artwork program, so the shape
   * of this is "give me the frame" rather than "here is a shader".
   */
  build(
    drawFrame: (w: number, h: number, fbo: WebGLFramebuffer, spp: number) => void,
    threshold: number,
  ): void {
    const { gl } = this;
    if (!this.program || !this.uniforms || this.src.width === 0) return;

    // 1. the frame, small.
    drawFrame(this.src.width, this.src.height, this.src.write.fbo, this.spp);
    this.src.swap();

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    this.uniforms.int('uSrc', 0);

    const pass = (stepX: number, stepY: number, extract: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.src.write.fbo);
      gl.viewport(0, 0, this.src.width, this.src.height);
      gl.bindTexture(gl.TEXTURE_2D, this.src.read.tex);
      this.uniforms!.vec2('uStep', stepX, stepY);
      this.uniforms!.int('uExtract', extract);
      this.uniforms!.float('uThreshold', threshold);
      this.uniforms!.float('uInvSamples', 1 / this.spp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.src.swap();
    };

    // 2. keep only what is over the threshold, then 3. blur it separably, the
    // stride doubling each iteration so the reach grows geometrically for a
    // linear number of passes.
    pass(0, 0, 1);
    for (let i = 0; i < this.iterations; i++) {
      const stride = 1 << i;
      pass(stride, 0, 0);
      pass(0, stride, 0);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.built = true;
  }

  dispose(): void {
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = null;
    this.uniforms = null;
    this.src.dispose();
  }
}
