import { PingPong } from '../gl/fbo.ts';
import { createProgram, Uniforms, type ShaderModule } from '../gl/program.ts';
import type { BufferBinding } from '../params/schema.ts';

export interface PassSpec {
  id: string;
  shader: ShaderModule & { buffers: BufferBinding[] };
  /**
   * Simulation grid size in texels along the SHORT side. Absolute, not a
   * fraction of the display: the pattern scale is set by the grid, so tying it
   * to the window would mean resizing the window changes the artwork. The long
   * side follows the aspect ratio, since aspect genuinely is composition.
   */
  size: number;
  /** Simulation steps per displayed frame. */
  substeps: number;
}

interface LivePass extends PassSpec {
  program: WebGLProgram;
  uniforms: Uniforms;
  target: PingPong;
}

export interface StepParams {
  time: number;
  frame: number;
  seed: number;
  quality: number;
  mouse: [number, number, number, number];
}

/**
 * The stateful half of the renderer: a chain of simulation passes, each with
 * its own float ping-pong target, run in declared order before the image pass.
 *
 * Two rules define the semantics, and they are the ones people expect from
 * ShaderToy's buffers:
 *   - a pass reading ITSELF sees its previous step (that is the feedback)
 *   - a pass reading an EARLIER pass sees that pass's current step
 *
 * Targets carry their own resolution. A simulation almost never wants to run at
 * print resolution — the pattern scale is set by the grid, so a 4x larger grid
 * is a different picture, not a sharper one. Running the sim at a fixed
 * moderate size and recovering detail in the image pass is the whole strategy
 * for printing stateful work.
 */
export class PassChain {
  private gl: WebGL2RenderingContext;
  private passes: LivePass[] = [];
  private pendingInit = true;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  get ids(): string[] {
    return this.passes.map((p) => p.id);
  }

  get length(): number {
    return this.passes.length;
  }

  /** True when the chain holds simulation state that advances with time. */
  get stateful(): boolean {
    return this.passes.length > 0;
  }

  setPasses(specs: PassSpec[]): void {
    this.dispose();
    this.passes = specs.map((spec) => {
      const program = createProgram(this.gl, spec.shader);
      return {
        ...spec,
        program,
        uniforms: new Uniforms(this.gl, program),
        target: new PingPong(this.gl),
      };
    });
    this.pendingInit = true;
  }

  /** Returns true if any target was reallocated, which voids the simulation. */
  resize(displayW: number, displayH: number): boolean {
    let changed = false;
    const short = Math.max(1, Math.min(displayW, displayH));
    for (const p of this.passes) {
      const w = Math.max(1, Math.round((p.size * displayW) / short));
      const h = Math.max(1, Math.round((p.size * displayH) / short));
      if (p.target.resize(w, h)) changed = true;
    }
    if (changed) this.pendingInit = true;
    return changed;
  }

  /** Seed the state on the next step. */
  reset(): void {
    this.pendingInit = true;
  }

  get needsInit(): boolean {
    return this.pendingInit;
  }

  /**
   * Run only the seeding step, leaving the state at its initial condition.
   *
   * Separate from step() so that "frame 0" can mean zero update steps. Folding
   * the seed into the first step would make frame 0 already one step old, and
   * then a sequence and a standalone render of the same frame would disagree
   * about what N steps means.
   */
  seed(p: StepParams, applyParams?: (u: Uniforms) => void): void {
    for (const pass of this.passes) this.draw(pass, p, applyParams, 0, 1);
    this.pendingInit = false;
  }

  /** Advance every pass by its substeps (preceded by an init step if pending). */
  step(p: StepParams, applyParams?: (u: Uniforms) => void): void {
    if (this.passes.length === 0) return;
    const init = this.pendingInit;
    for (const pass of this.passes) {
      if (init) this.draw(pass, p, applyParams, 0, 1);
      for (let s = 0; s < Math.max(1, pass.substeps); s++) {
        this.draw(pass, p, applyParams, s, 0);
      }
    }
    this.pendingInit = false;
  }

  private draw(
    pass: LivePass,
    p: StepParams,
    applyParams: ((u: Uniforms) => void) | undefined,
    substep: number,
    init: number,
  ): void {
    const { gl } = this;
    const w = pass.target.width;
    const h = pass.target.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, pass.target.write.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(pass.program);

    const u = pass.uniforms;
    // A buffer pass's "full resolution" is its own target, so artCoord(),
    // pxSize() and paUv() all mean what they say inside a simulation.
    u.vec2('uFullRes', w, h);
    u.vec2('uTileOrigin', 0, 0);
    u.float('uTime', p.time);
    u.int('uFrame', p.frame);
    u.int('uSeed', p.seed);
    u.int('uQuality', p.quality);
    u.int('uSpp', 1);
    u.int('uSampleBase', 0);
    u.int('uAccumEnable', 0);
    u.int('uInit', init);
    u.int('uSubstep', substep);
    u.int('uSubsteps', Math.max(1, pass.substeps));
    u.vec4('uMouse', p.mouse[0], p.mouse[1], p.mouse[2], p.mouse[3]);
    this.bind(u, pass.shader.buffers, 1, pass.id);
    if (applyParams) applyParams(u);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    pass.target.swap();
  }

  /**
   * Bind each declared buffer sampler to its pass's current texture, starting
   * at `unit`. Returns the next free unit.
   *
   * `selfId` is the pass doing the reading, if any: reading yourself has to
   * mean the previous step, which is what `read` holds while `write` is bound
   * as the target.
   */
  bind(u: Uniforms, bindings: BufferBinding[], unit: number, selfId?: string): number {
    const { gl } = this;
    let next = unit;
    for (const b of bindings) {
      const pass = this.passes.find((p) => p.id === b.pass);
      if (!pass) continue;
      gl.activeTexture(gl.TEXTURE0 + next);
      gl.bindTexture(gl.TEXTURE_2D, pass.target.read.tex);
      u.int(b.name, next);
      next++;
      void selfId; // read/write split already gives the right frame either way
    }
    gl.activeTexture(gl.TEXTURE0);
    return next;
  }

  dispose(): void {
    for (const p of this.passes) {
      this.gl.deleteProgram(p.program);
      p.target.dispose();
    }
    this.passes = [];
  }
}
