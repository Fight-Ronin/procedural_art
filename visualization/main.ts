import bloomShader from 'virtual:pa-bloom';
import resolveShader from 'virtual:pa-resolve';
import { ShaderCompileError } from './gl/program.ts';
import { Bloom } from './gl/bloom.ts';
import { Renderer, defaultParams } from './gl/renderer.ts';
import { PassChain } from './graph/chain.ts';
import type { PaHook } from './hook.ts';
import { glTileOrigin } from './render/tile.ts';
import { Gui, type Preset } from './params/gui.ts';
import { ParamStore } from './params/store.ts';
import { bloomSetup } from './piece.ts';
import { PIECES, pickPiece, type Piece } from './pieces.ts';
import { Clock } from './time/clock.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('error') as HTMLPreElement;

const renderer = new Renderer(canvas);
renderer.setResolve(resolveShader);
const chain = new PassChain(renderer.gl);
const bloom = new Bloom(renderer.gl, renderer.quadVao);
bloom.setShader(bloomShader);
const clock = new Clock(60);

/**
 * A paused frame keeps refining until this many samples. The cap exists so an
 * abandoned tab stops doing work, not because more would hurt.
 */
const MAX_SAMPLES = 4096;

/** Most frames a stateful piece will catch up in one animation frame. */
const MAX_CATCHUP = 4;

let piece = pickPiece(location.search);
const store = new ParamStore(piece.params);

// Structural bloom settings come from meta.json, not from the store: they
// decide how much buffer is allocated, which is a different kind of decision
// from how much halo to add.
const bloomCfg = bloomSetup(piece.meta.display);
bloom.size = bloomCfg.size;
bloom.iterations = bloomCfg.iterations;
const presets: Preset[] = piece.meta.presets ?? [];
const builtins = { seed: 0, spp: 1, quality: 0, paused: false };
const mouse: [number, number, number, number] = [0, 0, 0, 0];

store.fromHash(location.hash);
document.title = `${piece.id} ${piece.title}`;

function syncHash(): void {
  const h = store.toHash();
  history.replaceState(null, '', `${location.pathname}${location.search}${h ? `#${h}` : ''}`);
}

const gui = new Gui(store, {
  builtins,
  presets,
  pieces: PIECES.map((p) => ({ id: p.id, title: p.title })),
  currentPiece: piece.id,
  hasSim: piece.passes.length > 0,
  onResetSim() {
    simSeek(canvas.width, canvas.height, clock.frame);
  },
  onPiece(id) {
    // A different piece has a different parameter set, so start clean rather
    // than carrying a hash that means nothing here.
    location.href = `${location.pathname}?p=${id}`;
  },
  onChange: syncHash,
  onBuiltin: () => {},
  onLoadPreset(name) {
    const p = presets.find((x) => x.name === name);
    if (p) {
      store.load(p.values as never);
      syncHash();
    }
  },
  async onCapture(name) {
    const values = store.snapshot();
    try {
      const res = await fetch('/__pa/preset', {
        method: 'POST',
        body: JSON.stringify({ entry: piece.shader.entry, name, values }),
      });
      const json = (await res.json()) as { ok: boolean; path?: string; error?: string };
      if (!json.ok) return `capture failed: ${json.error}`;
      const at = presets.findIndex((p) => p.name === name);
      if (at >= 0) presets[at] = { name, values };
      else presets.push({ name, values });
      gui.rebuild(store);
      return `saved "${name}" to ${json.path}`;
    } catch {
      await navigator.clipboard.writeText(JSON.stringify({ name, values }, null, 2));
      return 'dev server unreachable — preset copied to clipboard';
    }
  },
  async onCopyUrl() {
    await navigator.clipboard.writeText(location.href);
    return 'url copied';
  },
  onReset() {
    store.reset();
    syncHash();
  },
});

function load(next: Piece): void {
  try {
    renderer.setShader(next.shader);
    chain.setPasses(next.passes);
    piece = next;
    store.adopt(next.params);
    gui.rebuild(store);
    syncHash();
    overlay.hidden = true;
    overlay.textContent = '';
  } catch (e) {
    if (e instanceof ShaderCompileError) {
      // The whole point of the source map: this reads as basics/<file>:<line>.
      overlay.hidden = false;
      overlay.textContent = `${e.entry}\n\n${e.message}`;
      console.error(e.message);
      return;
    }
    throw e;
  }
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/** Parameters plus buffer textures — everything a program needs beyond builtins. */
function applyAll(u: import('./gl/program.ts').Uniforms): void {
  store.apply(u);
  // Texture unit 0 is the accumulator; buffers start at 1.
  chain.bind(u, piece.shader.buffers, 1);
}

/**
 * Push the display transform to the renderer.
 *
 * These two live in the store like any parameter — so the GUI, the URL hash and
 * presets carry them — but they are consumed by the resolve pass, which runs
 * after the artwork and does not go through `applyAll`. Called before every
 * present, including the export paths, so a still and the preview cannot end up
 * with different transforms.
 */
function syncDisplay(fullW: number, fullH: number): void {
  renderer.displayExposure = (store.get('uDisplayExposure') as number) ?? 0;
  renderer.displayTonemap = (store.get('uDisplayTonemap') as number) ?? 1;
  renderer.outputRes = [fullW, fullH];
  renderer.bloomStrength = (store.get('uBloomStrength') as number) ?? 0;
  renderer.bloomTex = null;
}

/**
 * Build the bloom halo for this frame, if the piece asks for one.
 *
 * MUST run after the simulation is standing on the right frame and before the
 * present that reads it — and once for the WHOLE FRAME, never per tile, which
 * is the entire reason a tiled export stays byte-identical. `paramsFor` is
 * given the full output size at every call site, so the halo is the same
 * whether the caller then draws one tile or the lot.
 */
let lastBloomKey = '';

function buildBloom(p: ReturnType<typeof paramsFor>): void {
  if (renderer.bloomStrength <= 0 || !bloom.ready) return;
  bloom.resize(p.fullRes[0], p.fullRes[1]);
  // The halo is a whole-frame object, so every tile of one frame wants the
  // identical texture — building it per tile would be correct and sixteen
  // times the work on a 4x4 plan. Keyed on everything that can change it;
  // p.viewport and p.tileOrigin are deliberately absent, which is the same
  // statement as "a tile cannot observe the bloom".
  const key = [
    piece.id, p.fullRes[0], p.fullRes[1], p.frame, p.seed, p.quality,
    store.revision, bloom.size, bloom.iterations, simStep,
  ].join('|');
  if (key !== lastBloomKey) {
    lastBloomKey = key;
    bloom.build(
      (w, h, fbo, spp) => renderer.drawFrameInto(fbo, w, h, p, spp, applyAll),
      (store.get('uBloomThreshold') as number) ?? 1,
    );
  }
  renderer.bloomTex = bloom.texture;
}

function paramsFor(w: number, h: number) {
  // Every render path — live draw, still, tile, deep tile — goes through here,
  // which makes it the one place the display transform can be pushed without
  // five call sites to keep in step. It is a side effect in a function that
  // reads like a pure one, and that is the trade: a missed site would give the
  // preview and the export different transforms, silently.
  syncDisplay(w, h);
  const p = defaultParams(w, h);
  p.time = clock.time;
  p.frame = clock.frame;
  p.seed = builtins.seed;
  p.spp = builtins.spp;
  p.quality = builtins.quality;
  p.mouse = mouse;
  return p;
}

/**
 * Everything that invalidates accumulated samples. Rendering more samples of a
 * different image is worse than starting over, so this is compared every frame
 * and a change resets the accumulator.
 */
function signature(): string {
  return [
    piece.id, canvas.width, canvas.height, clock.frame,
    builtins.seed, builtins.quality, builtins.spp, store.revision,
  ].join('|');
}
let lastSignature = '';

/**
 * The simulation is reset far less eagerly than the accumulator. Changing feed
 * or kill mid-run and watching the pattern respond is the point of a live
 * reaction-diffusion; only a genuinely new initial condition justifies throwing
 * the state away.
 *
 * Deliberately NOT keyed on the canvas size. Pass grids are sized absolutely,
 * so resizing the window does not change them — and keying on the canvas here
 * re-seeded the simulation on every resize, which looks exactly like a
 * simulation that refuses to evolve. chain.resize() already flags a re-init
 * when a grid really is reallocated.
 */
function simSignature(): string {
  return [piece.id, builtins.seed].join('|');
}
let lastSimSignature = '';

/**
 * Steps taken since the simulation was last seeded.
 *
 * THE model for stateful work: frame N means the simulation has been stepped
 * exactly N times since seeding, and the step counter — not the wall clock, not
 * the piece's own frame number — is what a buffer pass sees as uFrame. Having
 * "which frame" and "how far the simulation has run" as two independent knobs
 * is incoherent, and it is what would let a sequence render and a standalone
 * render of the same frame disagree.
 */
let simStep = 0;

function simAdvance(n: number): void {
  if (chain.length === 0 || n <= 0) return;
  for (let i = 0; i < n; i++) {
    chain.step(
      {
        time: simStep / clock.fps,
        frame: simStep,
        seed: builtins.seed,
        quality: builtins.quality,
        mouse,
      },
      (u) => store.apply(u),
    );
    simStep++;
  }
  renderer.reset();
}

/** Seed, then run forward to `frame`. O(frame) by nature for a simulation. */
function simSeek(fullW: number, fullH: number, frame: number): void {
  clock.seek(frame);
  if (chain.length === 0) return;
  chain.resize(fullW, fullH);
  chain.reset();
  chain.seed(
    { time: 0, frame: 0, seed: builtins.seed, quality: builtins.quality, mouse },
    (u) => store.apply(u),
  );
  simStep = 0;
  simAdvance(frame);
  renderer.reset();
}

/**
 * Bring the chain in line with the canvas and the settings, re-seeding if
 * anything that defines the initial condition changed.
 *
 * This has to run before ANYTHING steps the simulation, not merely before the
 * image is drawn. It used to live inside draw(), and tick() stepped first and
 * drew second — so on the very first animation frame of a stateful piece the
 * chain's targets had never been allocated, chain.step() threw, and because the
 * throw happened before tick() re-scheduled itself the whole animation loop
 * died. A frozen canvas, no visible error.
 */
function syncSim(): void {
  if (chain.length === 0) return;
  // resize() allocates, so it is called for its effect every time, never
  // short-circuited by the checks that follow it.
  const reallocated = chain.resize(canvas.width, canvas.height);
  const simSig = simSignature();
  if (reallocated || chain.needsInit || simSig !== lastSimSignature) {
    lastSimSignature = simSig;
    simSeek(canvas.width, canvas.height, clock.frame);
  }
}

function draw(): void {
  resize();
  syncSim();

  const sig = signature();
  if (sig !== lastSignature) {
    renderer.reset();
    lastSignature = sig;
  }
  // While playing, every frame is a new image, so each gets one batch. While
  // paused, batches pile up and the picture refines — which is what makes a
  // noisy piece like 002 usable, and keeps each draw short enough that the
  // driver's watchdog never sees a long one.
  const p = paramsFor(canvas.width, canvas.height);
  if (renderer.samples === 0 || (builtins.paused && renderer.samples < MAX_SAMPLES)) {
    renderer.accumulate(p, applyAll);
  }
  buildBloom(p);
  renderer.present(canvas.width, canvas.height);
  gui.setStatus(
    `${renderer.samples} spp · ${renderer.format.name}` +
      (builtins.paused ? (renderer.samples >= MAX_SAMPLES ? ' · converged' : ' · refining') : ''),
  );
}

// Play at real-world speed while keeping every rendered frame an exact,
// reproducible export frame: accumulate elapsed time, advance whole frames.
let carry = 0;
let last = performance.now();
let looping = true;

function tick(now: number): void {
  if (!looping) return;
  try {
    frameBody(now);
  } catch (e) {
    // Stop cleanly and say so. Re-throwing here would kill the loop silently
    // and leave a frozen canvas with no explanation; retrying would print the
    // same error sixty times a second.
    looping = false;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('render loop stopped:', e);
    gui.setStatus(`stopped: ${msg}`);
    return;
  }
  requestAnimationFrame(tick);
}

function frameBody(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  // Size and seed before stepping: simAdvance() writes into the chain's
  // targets, and they only exist once syncSim() has allocated them.
  resize();
  syncSim();
  if (!builtins.paused) {
    carry += dt * clock.fps;
    let steps = Math.floor(carry);
    carry -= steps;
    // The clock and the simulation move together or not at all: letting the
    // clock outrun the stepping would make the preview show a frame the
    // exporter would never produce. On a machine too slow to keep up, playback
    // slows down rather than desynchronising — and the cap stops a slow frame
    // from asking for even more work on the next one.
    if (chain.length > 0 && steps > MAX_CATCHUP) {
      steps = MAX_CATCHUP;
      carry = 0;
    }
    clock.advance(steps);
    simAdvance(steps);
  }
  draw();
}

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  mouse[0] = (e.clientX - r.left) * dpr;
  mouse[1] = (r.bottom - e.clientY) * dpr;
});
canvas.addEventListener('pointerdown', () => {
  mouse[2] = mouse[0];
  mouse[3] = mouse[1];
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.key === ' ') {
    builtins.paused = !builtins.paused;
    e.preventDefault();
  } else if (e.key === 'h') {
    gui.toggle();
  } else if (e.key === 'r') {
    builtins.seed = Math.floor(Math.random() * 1e6);
    gui.rebuild(store);
  } else if (e.key === 'ArrowRight') {
    // Same ordering rule as the animation loop: nothing steps before syncSim.
    resize();
    syncSim();
    clock.advance(1);
    simAdvance(1);
  } else if (e.key === 'ArrowLeft') {
    // Stepping back means re-deriving the state: a simulation has no reverse.
    simSeek(canvas.width, canvas.height, Math.max(0, clock.frame - 1));
  } else if (e.key === '0') {
    simSeek(canvas.width, canvas.height, 0);
  }
});

load(piece);
requestAnimationFrame(tick);

/**
 * Put the piece at an exact buffer size and an exact frame, ready to draw.
 *
 * Every headless entry point that takes a `frame` goes through here, so `frame`
 * means one thing everywhere: the simulation has been stepped exactly that many
 * times since seeding. The seek is unconditional rather than memoised — a cache
 * here would have to be invalidated by the seed, the piece, every parameter and
 * the grid size, and getting that wrong is silent (a render of the wrong
 * moment, which looks like a plausible image). The one caller that cannot
 * afford it, renderTile, says so and seeks once for the whole tile plan.
 */
function place(w: number, h: number, frame: number): void {
  builtins.paused = true;
  canvas.width = w;
  canvas.height = h;
  simSeek(w, h, frame);
}

// Headless driving hook. `satisfies PaHook` is what makes removing or renaming
// a method here a compile error in the tools that call it, rather than a
// run-time surprise.
const hook = {
    store,
    get piece() {
      return piece.id;
    },
    /** Render at an exact buffer size, bypassing DPR. For verification. */
    renderAt(w: number, h: number, frame: number, spp = 1) {
      builtins.spp = spp;
      builtins.quality = spp > 1 ? 1 : 0;
      place(w, h, frame);
      const p = paramsFor(w, h);
      renderer.reset();
      renderer.accumulate(p, applyAll);
      buildBloom(p);
      renderer.present(w, h);
      return Array.from(renderer.readPixels(w, h));
    },
    /**
     * N draws of `spp` samples each, accumulated. Must match one draw of N*spp.
     * Quality follows the TOTAL sample count, not the per-draw spp: uQuality
     * changes the image (001 gates its octave count on it), and it has to be
     * constant across an accumulation run or samples from two different images
     * get averaged together.
     */
    accumulateAt(w: number, h: number, frame: number, draws: number, spp = 1) {
      builtins.spp = spp;
      builtins.quality = draws * spp > 1 ? 1 : 0;
      place(w, h, frame);
      renderer.reset();
      const p = paramsFor(w, h);
      for (let i = 0; i < draws; i++) renderer.accumulate(p, applyAll);
      buildBloom(p);
      renderer.present(w, h);
      return Array.from(renderer.readPixels(w, h));
    },
    /**
     * Put the piece at `frame`, for an output of this size.
     *
     * For a stateful piece this re-derives the state by seeding and stepping
     * `frame` times, which is O(frame) and unavoidable — a simulation has no
     * reverse. It is also done ONCE, before any tile: the state is a
     * whole-frame object, so stepping inside the tile loop would put every tile
     * at a different moment.
     */
    seekTo(fullW: number, fullH: number, frame: number) {
      builtins.paused = true;
      simSeek(fullW, fullH, frame);
    },
    /** One frame on: the clock and the simulation together, never apart. */
    advanceFrame(n = 1) {
      clock.advance(n);
      simAdvance(n);
    },
    /**
     * Render one tile of a larger output. `uFullRes` stays the full size and
     * `uTileOrigin` carries the offset, so nothing the artwork can see changes
     * with the tiling — which is why the result is bit-identical to an untiled
     * render, not merely close.
     *
     * The one entry point that does NOT seek: seeking per tile would repeat an
     * O(frame) simulation once per tile, and a 16-tile print would run it 16
     * times over. The caller seeks once, and the check below makes the omission
     * loud — an unseeded or misplaced chain fails here rather than quietly
     * producing a beautiful picture of the wrong moment.
     */
    renderTile(
      fullW: number,
      fullH: number,
      tile: { x: number; y: number; w: number; h: number },
      frame: number,
      draws: number,
      spp: number,
    ) {
      if (chain.length > 0 && simStep !== frame) {
        throw new Error(
          `renderTile(frame ${frame}) but the simulation is at step ${simStep}; ` +
            'call seekTo() before the tile loop',
        );
      }
      builtins.paused = true;
      builtins.spp = spp;
      builtins.quality = draws * spp > 1 ? 1 : 0;
      clock.seek(frame);
      canvas.width = tile.w;
      canvas.height = tile.h;
      const p = paramsFor(fullW, fullH);
      p.viewport = [tile.w, tile.h];
      // Tiles are top-left down; gl_FragCoord counts from the bottom.
      p.tileOrigin = glTileOrigin(tile, fullH);
      renderer.reset();
      for (let i = 0; i < draws; i++) renderer.accumulate(p, applyAll);
      // The resolve pass dithers, and its dither is keyed on the absolute
      // pixel — so it needs the same origin the artwork pass got.
      buildBloom(p);
      renderer.present(tile.w, tile.h, p.tileOrigin);
      return Array.from(renderer.readPixels(tile.w, tile.h));
    },
    /** The same tile at 16 bits. Shares every step but the final quantisation. */
    renderTile16(
      fullW: number,
      fullH: number,
      tile: { x: number; y: number; w: number; h: number },
      frame: number,
      draws: number,
      spp: number,
    ) {
      if (chain.length > 0 && simStep !== frame) {
        throw new Error(
          `renderTile16(frame ${frame}) but the simulation is at step ${simStep}; ` +
            'call seekTo() before the tile loop',
        );
      }
      builtins.paused = true;
      builtins.spp = spp;
      builtins.quality = draws * spp > 1 ? 1 : 0;
      clock.seek(frame);
      canvas.width = tile.w;
      canvas.height = tile.h;
      const p = paramsFor(fullW, fullH);
      p.viewport = [tile.w, tile.h];
      p.tileOrigin = glTileOrigin(tile, fullH);
      renderer.reset();
      for (let i = 0; i < draws; i++) renderer.accumulate(p, applyAll);
      buildBloom(p);
      return Array.from(renderer.readDeep(tile.w, tile.h, p.tileOrigin));
    },
    get samples() {
      return renderer.samples;
    },
    get frame() {
      return clock.frame;
    },
    get paused() {
      return builtins.paused;
    },
    setPaused(v: boolean) {
      builtins.paused = v;
    },
    setSeed(n: number) {
      builtins.seed = n;
    },
    /**
     * Renderer identity. A golden reference image is only bit-valid for the
     * renderer that produced it — transcendentals differ between drivers — so
     * the comparison has to know what it is looking at rather than assume.
     */
    glInfo() {
      const gl = renderer.gl;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: String(gl.getParameter(gl.RENDERER)),
        vendor: String(gl.getParameter(gl.VENDOR)),
        version: String(gl.getParameter(gl.VERSION)),
        unmasked: dbg
          ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
          : null,
        format: renderer.format.name,
      };
    },
    get pieces() {
      return PIECES.map((p) => p.id);
    },
    get passes() {
      return chain.ids;
    },
    resetSim() {
      simSeek(canvas.width, canvas.height, clock.frame);
    },
    get simStep() {
      return simStep;
    },
    /** Tests drive rendering explicitly; the RAF loop would race with them. */
    stopLoop() {
      looping = false;
    },
    get format() {
      return renderer.format.name;
    },
    setParam(name: string, value: number | number[] | boolean) {
      store.set(name, value);
    },
    snapshot() {
      return store.snapshot();
    },
    loadValues(values: Record<string, unknown>) {
      const known = new Set(store.specs.map((s) => s.name));
      const unknown = Object.keys(values).filter((n) => !known.has(n));
      store.load(values as never);

      // The round trip is the test. `snapshot()` is the exact form a preset was
      // captured in, so a value that reproduces comes back identical to the one
      // asked for; anything clamped, rounded or dropped through an enum comes
      // back different. Comparing this way covers all three without the caller
      // needing to know the coercion rules for each parameter kind.
      const after = store.snapshot();
      const same = (a: unknown, b: unknown) =>
        typeof a === 'string' && typeof b === 'string'
          ? a.toLowerCase() === b.toLowerCase() // hex colours, either case
          : JSON.stringify(a) === JSON.stringify(b);
      const changed = Object.keys(values).filter(
        (n) => known.has(n) && !same(after[n], values[n]),
      );
      return { unknown, changed };
    },
    dataURL() {
      return canvas.toDataURL('image/png');
    },
    get ok() {
      return renderer.ready && overlay.hidden;
    },
    get error() {
      return overlay.textContent;
    },
} satisfies PaHook as unknown as PaHook;

Object.assign(window as unknown as Record<string, unknown>, { __pa: hook });

if (import.meta.hot) {
  import.meta.hot.accept('./pieces.ts', (m) => {
    if (!m) return;
    const mod = m as unknown as { pickPiece(s: string): Piece };
    load(mod.pickPiece(location.search));
  });
}
