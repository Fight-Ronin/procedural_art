import { formatShaderError } from '../build/errors.ts';
import type { MapEntry } from '../build/include.ts';

/** What the Vite plugin emits for every artwork .frag. */
export interface ShaderModule {
  code: string;
  map: MapEntry[];
  entry: string;
}

/**
 * Fullscreen triangle with no vertex buffer at all — gl_VertexID does the
 * work. One triangle rather than two: no diagonal seam in the interpolators,
 * and one fewer thing to own.
 */
const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class ShaderCompileError extends Error {
  entry: string;

  constructor(message: string, entry: string) {
    super(message);
    this.name = 'ShaderCompileError';
    this.entry = entry;
  }
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  mod: ShaderModule | null,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;

  const log = gl.getShaderInfoLog(shader) ?? '(no log)';
  gl.deleteShader(shader);
  if (!mod) throw new ShaderCompileError(log, '<vertex>');
  throw new ShaderCompileError(
    formatShaderError(log, mod.code, mod.map),
    mod.entry,
  );
}

export function createProgram(
  gl: WebGL2RenderingContext,
  mod: ShaderModule,
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, null);
  const fs = compile(gl, gl.FRAGMENT_SHADER, mod.code, mod);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(no log)';
    gl.deleteProgram(program);
    throw new ShaderCompileError(
      formatShaderError(log, mod.code, mod.map),
      mod.entry,
    );
  }
  return program;
}

/** Cache of uniform locations; missing names resolve to null and are skipped. */
export class Uniforms {
  private cache = new Map<string, WebGLUniformLocation | null>();
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;

  constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {
    this.gl = gl;
    this.program = program;
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.cache.has(name)) {
      this.cache.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.cache.get(name) ?? null;
  }

  int(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  float(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  vec2(name: string, x: number, y: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }
  vec3(name: string, x: number, y: number, z: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }
  vec4(name: string, x: number, y: number, z: number, w: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }
}
