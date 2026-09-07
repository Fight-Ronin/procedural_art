import { PingPong, type FloatFormat } from './fbo.ts';
import { createProgram, Uniforms, type ShaderModule } from './program.ts';

export interface RenderParams {
  /** Full output resolution in px. Under tiling this is NOT the viewport. */
  fullRes: [number, number];
  /** Px offset of this tile inside the full output. */
  tileOrigin: [number, number];
  /** Viewport (framebuffer) size in px. */
  viewport: [number, number];
  time: number;
  frame: number;
  seed: number;
  /** Samples per pixel in this draw. */
  spp: number;
  /** Ordinal of this draw's first sample; set by the renderer under accumulation. */
  sampleBase: number;
  /** 0 = preview, 1 = final. Artworks gate march/sample counts on this. */
  quality: number;
  mouse: [number, number, number, number];
}

export function defaultParams(w: number, h: number): RenderParams {
  return {
    fullRes: [w, h],
    tileOrigin: [0, 0],
    viewport: [w, h],
    time: 0,
    frame: 0,
    seed: 0,
    spp: 1,
    sampleBase: 0,
    quality: 0,
    mouse: [0, 0, 0, 0],
  };
}

/**
 * Two-stage renderer.
 *
 *   artwork pass -> float accumulator (unnormalised linear)
 *   resolve pass -> canvas (divide by sample count, encode to sRGB)
 *
 * Always both stages, even for a single sample. Going through a float target
 * unconditionally is what makes progressive refinement, HDR headroom and
 * (later) float readback for export one code path instead of three, and it puts
 * the display encode in exactly one place.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly format: FloatFormat;

  private vao: WebGLVertexArrayObject | null;

  /**
   * The full-screen triangle every pass draws with.
   *
   * Exposed so the bloom pass can share it: a second VAO for the same three
   * vertices would be one more thing to keep in step with nothing to gain.
   */
  get quadVao(): WebGLVertexArrayObject | null {
    return this.vao;
  }
  private accum: PingPong;
  private program: WebGLProgram | null = null;
  private uniforms: Uniforms | null = null;
  private resolveProgram: WebGLProgram | null = null;
  private resolveUniforms: Uniforms | null = null;
  private accumulated = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false, // we supersample in the shader instead
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // so toDataURL / readPixels works after a frame
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.accum = new PingPong(gl);
    this.format = this.accum.format;
  }

  /** How many samples are currently summed into the accumulator. */
  get samples(): number {
    return this.accumulated;
  }

  get ready(): boolean {
    return this.program !== null && this.resolveProgram !== null;
  }

  /** Swap in a newly compiled artwork. Throws ShaderCompileError on failure. */
  setShader(mod: ShaderModule): void {
    const next = createProgram(this.gl, mod);
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = next;
    this.uniforms = new Uniforms(this.gl, next);
    this.reset();
  }

  /** Install viz's own resolve shader (the virtual:pa-resolve module). */
  setResolve(mod: ShaderModule): void {
    const next = createProgram(this.gl, mod);
    if (this.resolveProgram) this.gl.deleteProgram(this.resolveProgram);
    this.resolveProgram = next;
    this.resolveUniforms = new Uniforms(this.gl, next);
  }

  /** Returns true if storage was reallocated, which voids any accumulation. */
  resize(w: number, h: number): boolean {
    const changed = this.accum.resize(w, h);
    if (changed) this.reset();
    return changed;
  }

  reset(): void {
    this.accumulated = 0;
  }

  /**
   * Add one batch of `p.spp` samples to the accumulator. The caller does not
   * set `sampleBase`: sample ordinals have to be globally monotonic across
   * batches or the low-discrepancy sequences would restart every draw and the
   * accumulation would converge to the wrong image.
   */
  accumulate(p: RenderParams, applyExtra?: (u: Uniforms) => void): void {
    const { gl } = this;
    if (!this.program || !this.uniforms) return;
    this.accum.resize(p.viewport[0], p.viewport[1]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.write.fbo);
    gl.viewport(0, 0, p.viewport[0], p.viewport[1]);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accum.read.tex);

    const u = this.uniforms;
    u.vec2('uFullRes', p.fullRes[0], p.fullRes[1]);
    u.vec2('uTileOrigin', p.tileOrigin[0], p.tileOrigin[1]);
    u.float('uTime', p.time);
    u.int('uFrame', p.frame);
    u.int('uSeed', p.seed);
    u.int('uSpp', p.spp);
    u.int('uSampleBase', this.accumulated);
    u.int('uQuality', p.quality);
    u.vec4('uMouse', p.mouse[0], p.mouse[1], p.mouse[2], p.mouse[3]);
    u.int('uAccumTex', 0);
    u.int('uAccumEnable', this.accumulated > 0 ? 1 : 0);
    if (applyExtra) applyExtra(u);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.accum.swap();
    this.accumulated += Math.max(1, p.spp);
  }

  /**
   * One step of the output's channel depth, in display units — the width of the
   * dither applied in the resolve pass. 1/255 matches the 8-bit canvas; a
   * deeper output path sets its own, and zero turns dithering off.
   */
  ditherLsb = 1 / 255;

  /**
   * The display transform, set from the store each frame.
   *
   * Renderer fields rather than a store reference: the renderer has never known
   * what a parameter is, and giving it one now would put the artwork's
   * vocabulary inside the layer whose whole job is not to have it.
   */
  displayExposure = 0;
  displayTonemap = 1;

  /**
   * The bloom halo and how much of it to add, in linear light.
   *
   * Strength 0 means the resolve never samples the texture, so a piece without
   * bloom pays nothing — not even a bind.
   */
  bloomTex: WebGLTexture | null = null;
  bloomStrength = 0;

  /**
   * The FULL output resolution, which under tiling is not the viewport.
   *
   * The resolve pass needs it to place a tile inside the halo, for the same
   * reason it needs uTileOrigin for the dither: gl_FragCoord there is
   * tile-local, so without both every tile would sample the same corner of the
   * bloom and the seams would be spectacular.
   */
  outputRes: [number, number] = [1, 1];

  /**
   * Draw the artwork ONCE into `fbo` at `w` x `h`, outside the accumulator.
   *
   * The bloom source needs a whole frame at its own small size while the
   * accumulator holds a tile at the output's size, so it cannot go through
   * `accumulate`. Accumulation is explicitly off (uAccumEnable = 0) and the
   * accumulator's own state is untouched, which is what lets this run in the
   * middle of a progressive refinement without disturbing it.
   */
  drawFrameInto(
    fbo: WebGLFramebuffer,
    w: number,
    h: number,
    p: RenderParams,
    spp: number,
    applyExtra?: (u: Uniforms) => void,
  ): void {
    const { gl } = this;
    if (!this.program || !this.uniforms) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const u = this.uniforms;
    u.vec2('uFullRes', w, h);
    u.vec2('uTileOrigin', 0, 0);
    u.float('uTime', p.time);
    u.int('uFrame', p.frame);
    u.int('uSeed', p.seed);
    u.int('uSpp', Math.max(1, spp));
    u.int('uSampleBase', 0);
    u.int('uQuality', p.quality);
    u.vec4('uMouse', p.mouse[0], p.mouse[1], p.mouse[2], p.mouse[3]);
    u.int('uAccumTex', 0);
    u.int('uAccumEnable', 0);
    if (applyExtra) applyExtra(u);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Float target for the deep readback path; allocated only if it is used. */
  private deep: PingPong | null = null;

  /**
   * Divide the accumulator by the sample count and encode it to the canvas.
   *
   * `tileOrigin` is where this tile sits in the full output. It must be given
   * whenever the accumulator holds a tile rather than a whole frame, because
   * the dither is keyed on the absolute pixel; getting it wrong makes a tiled
   * export differ from an untiled one, which test/export.test.ts checks.
   */
  present(w: number, h: number, tileOrigin: readonly [number, number] = [0, 0]): void {
    const { gl } = this;
    if (!this.resolveProgram || !this.resolveUniforms || this.accumulated === 0) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.resolveProgram);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accum.read.tex);
    this.resolveUniforms.int('uAccum', 0);
    this.resolveUniforms.float('uInvSamples', 1 / this.accumulated);
    this.resolveUniforms.vec2('uTileOrigin', tileOrigin[0], tileOrigin[1]);
    this.resolveUniforms.float('uDitherLsb', this.ditherLsb);
    this.resolveUniforms.float('uDisplayExposure', this.displayExposure);
    this.resolveUniforms.int('uDisplayTonemap', this.displayTonemap);
    // Unit 1: unit 0 is the accumulator this pass is reading.
    this.resolveUniforms.float('uBloomStrength', this.bloomTex ? this.bloomStrength : 0);
    this.resolveUniforms.vec2('uFullRes', this.outputRes[0], this.outputRes[1]);
    if (this.bloomTex && this.bloomStrength > 0) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex);
      this.resolveUniforms.int('uBloomTex', 1);
      gl.activeTexture(gl.TEXTURE0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** One-shot: discard any accumulation, draw p.spp samples, show the result. */
  render(p: RenderParams, applyExtra?: (u: Uniforms) => void): void {
    this.reset();
    this.accumulate(p, applyExtra);
    this.present(p.viewport[0], p.viewport[1], p.tileOrigin);
  }

  /**
   * Resolve into a float target and read it back as 16-bit samples.
   *
   * The 8-bit path resolves straight to the canvas, so its output is quantised
   * by the framebuffer before anyone can look at it. For a deeper output the
   * resolve has to land somewhere that holds more, and that somewhere must be
   * RGBA32F rather than RGBA16F: half-float carries a 10-bit mantissa, so near
   * white its steps are about 1/1024 — COARSER than the 16-bit integers it
   * would be feeding, which would make the deep path quietly worse than the
   * shallow one in exactly the highlights it exists to protect.
   *
   * The sRGB encode still happens once, in GLSL, in the resolve pass. Only the
   * final scaling to integers happens here, which is arithmetic rather than a
   * second definition of the transfer function.
   */
  readDeep(w: number, h: number, tileOrigin: readonly [number, number] = [0, 0]): Uint16Array {
    const { gl } = this;
    if (!this.resolveProgram || !this.resolveUniforms || this.accumulated === 0) {
      return new Uint16Array(w * h * 4);
    }
    if (!this.deep) this.deep = new PingPong(gl);
    this.deep.resize(w, h);

    const prevLsb = this.ditherLsb;
    // Dither has to match the depth being written. Carrying the 8-bit width
    // into a 16-bit file would put 256 times too much noise in the file that
    // was supposed to be the cleaner one.
    this.ditherLsb = prevLsb > 0 ? 1 / 65535 : 0;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.deep.read.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.resolveProgram);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.accum.read.tex);
      this.resolveUniforms.int('uAccum', 0);
      this.resolveUniforms.float('uInvSamples', 1 / this.accumulated);
      this.resolveUniforms.vec2('uTileOrigin', tileOrigin[0], tileOrigin[1]);
      this.resolveUniforms.float('uDitherLsb', this.ditherLsb);
      this.resolveUniforms.float('uDisplayExposure', this.displayExposure);
      this.resolveUniforms.int('uDisplayTonemap', this.displayTonemap);
      // Unit 1: unit 0 is the accumulator this pass is reading.
      this.resolveUniforms.float('uBloomStrength', this.bloomTex ? this.bloomStrength : 0);
      this.resolveUniforms.vec2('uFullRes', this.outputRes[0], this.outputRes[1]);
      if (this.bloomTex && this.bloomStrength > 0) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomTex);
        this.resolveUniforms.int('uBloomTex', 1);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const floats = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, floats);

      // Flip to top-left origin and quantise, in one pass.
      const out = new Uint16Array(w * h * 4);
      const row = w * 4;
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * row;
        for (let i = 0; i < row; i++) {
          const v = floats[src + i];
          out[y * row + i] = v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
        }
      }
      return out;
    } finally {
      this.ditherLsb = prevLsb;
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  /** RGBA bytes of the canvas, top-left origin. */
  readPixels(w: number, h: number): Uint8Array {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const flipped = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    const out = new Uint8Array(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      out.set(flipped.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
    return out;
  }
}
