/**
 * Floating-point render targets.
 *
 * Everything the artwork produces is linear light with no upper bound —
 * highlights in 002 run well past 1.0 before the tonemap. Accumulating that in
 * 8-bit would clip every one of them to white on the first sample, so the
 * accumulator has to be float, and the display encode has to happen after the
 * division rather than inside the artwork pass.
 */

export interface FloatFormat {
  internal: number;
  type: number;
  name: string;
  /** RGBA8 means no usable accumulation; the caller should disable it. */
  usable: boolean;
}

export function pickFloatFormat(gl: WebGL2RenderingContext): FloatFormat {
  if (gl.getExtension('EXT_color_buffer_float')) {
    return { internal: gl.RGBA32F, type: gl.FLOAT, name: 'RGBA32F', usable: true };
  }
  if (gl.getExtension('EXT_color_buffer_half_float')) {
    // 10-bit mantissa: fine for a few hundred samples, drifts beyond that.
    return { internal: gl.RGBA16F, type: gl.HALF_FLOAT, name: 'RGBA16F', usable: true };
  }
  return { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE, name: 'RGBA8', usable: false };
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

function makeTarget(
  gl: WebGL2RenderingContext,
  fmt: FloatFormat,
  w: number,
  h: number,
): Target {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, w, h);
  // NEAREST throughout: every read is a texelFetch at an exact pixel, and
  // RGBA32F is not filterable without OES_texture_float_linear anyway.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('createFramebuffer failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`framebuffer incomplete: 0x${status.toString(16)} (${fmt.name} ${w}x${h})`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { tex, fbo };
}

/**
 * A pair of float targets. Accumulation reads one and writes the other rather
 * than using additive blending, because blending into RGBA32F needs
 * EXT_float_blend, which is not universally present — and a half-float
 * fallback would lose precision exactly where accumulation is supposed to buy
 * it. One texture read per pixel is the cheaper trade.
 */
export class PingPong {
  readonly format: FloatFormat;
  width = 0;
  height = 0;
  private gl: WebGL2RenderingContext;
  private a: Target | null = null;
  private b: Target | null = null;

  constructor(gl: WebGL2RenderingContext, format?: FloatFormat) {
    this.gl = gl;
    this.format = format ?? pickFloatFormat(gl);
  }

  /** True if the storage changed, meaning any accumulation is now void. */
  resize(w: number, h: number): boolean {
    if (this.a && this.width === w && this.height === h) return false;
    this.dispose();
    this.a = makeTarget(this.gl, this.format, w, h);
    this.b = makeTarget(this.gl, this.format, w, h);
    this.width = w;
    this.height = h;
    return true;
  }

  get read(): Target {
    if (!this.a) throw new Error('PingPong used before resize()');
    return this.a;
  }

  get write(): Target {
    if (!this.b) throw new Error('PingPong used before resize()');
    return this.b;
  }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  clear(): void {
    const { gl } = this;
    for (const t of [this.a, this.b]) {
      if (!t) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    const { gl } = this;
    for (const t of [this.a, this.b]) {
      if (!t) continue;
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.a = null;
    this.b = null;
  }
}
