/**
 * Is a piece's motion a rigid translation, or does the field actually deform?
 *
 *   node --experimental-strip-types tools/motion.ts 001 --frames 0,180,360,720
 *
 * Renders the piece at several frames and, for each frame against frame 0,
 * reports two numbers:
 *
 *   raw   — mean |delta| with the two frames laid on top of each other
 *   best  — mean |delta| after sliding one over the other by the integer offset
 *           that minimises it, measured on a centre crop so nothing that
 *           entered from outside is compared against nothing
 *
 * A pure pan has raw large and best ~ 0: every feature is still there, just
 * somewhere else. A field that is actually evolving cannot be registered away,
 * so best stays high. The ratio best/raw is the fraction of the change that is
 * NOT explained by a translation, which is the thing "flowing" means.
 */
import { renderStill } from './export.ts';
import { pieceRefs } from './ref.ts';
import { launch } from './session.ts';
import type { Image } from './png.ts';

const args = process.argv.slice(2);
const ids = args.filter((a, i) => /^\d{3}$/.test(a) && !(i > 0 && args[i - 1].startsWith('--')));
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const FRAMES = flag('frames', '0,180,360,720').split(',').map(Number);
const SIZE = Number(flag('size', '256'));
const SPP = Number(flag('spp', '4'));
const SEARCH = Number(flag('search', '0')) || Math.floor(SIZE * 0.45);
const CROP = Number(flag('crop', '0')) || Math.floor(SIZE * 0.35);
const SET = args.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => {
  const [n, v] = a.split('=');
  return { n, v: Number(v) };
});

if (ids.length !== 1) {
  console.error('usage: node --experimental-strip-types tools/motion.ts <id> [--frames a,b,c] [--size N] [--spp N] [uParam=value ...]');
  process.exit(2);
}

/** Luma of one pixel, as the registration signal. */
function luma(img: Image): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2];
  }
  return out;
}

/**
 * Mean |a - b| over a centred crop of `a`, with `b` sampled at an offset.
 * Returns Infinity when the offset would take the window outside `b`, so the
 * search never rewards an offset by comparing fewer pixels.
 */
function residual(a: Float32Array, b: Float32Array, n: number, half: number, dx: number, dy: number): number {
  const c = n >> 1;
  const x0 = c - half, x1 = c + half, y0 = c - half, y1 = c + half;
  if (x0 + dx < 0 || x1 + dx >= n || y0 + dy < 0 || y1 + dy >= n) return Infinity;
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += Math.abs(a[y * n + x] - b[(y + dy) * n + (x + dx)]);
      count++;
    }
  }
  return sum / count;
}

const piece = pieceRefs(ids)[0];
const session = await launch(5233);
try {
  await session.open(`?p=${piece.id}`);
  const err = await session.page.evaluate(() => window.__pa.error);
  if (err) {
    console.error(`${piece.id} failed to compile\n${err}`);
    process.exit(1);
  }
  // The vignette is fixed in the frame, so it never translates with the field
  // and would put a floor under every shifted comparison. Off by default; pass
  // it explicitly to keep it.
  const sets = SET.length ? SET : [{ n: 'uVignette', v: 0 }];
  for (const s of sets) {
    await session.page.evaluate((p: { n: string; v: number }) => window.__pa.setParam(p.n, p.v), s);
  }
  console.log(`${piece.id}  ${sets.map((s) => `${s.n}=${s.v}`).join(' ')}  size ${SIZE}  spp ${SPP}`);

  const imgs: Float32Array[] = [];
  for (const frame of FRAMES) {
    const img = await renderStill(session.page, {
      width: SIZE, height: SIZE, tile: 1024, draws: 1, spp: SPP, frame,
    });
    imgs.push(luma(img));
  }

  console.log('  frame     raw    best   at (dx,dy)   best/raw');
  for (let i = 1; i < FRAMES.length; i++) {
    const raw = residual(imgs[0], imgs[i], SIZE, CROP, 0, 0);
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -SEARCH; dy <= SEARCH; dy++) {
      for (let dx = -SEARCH; dx <= SEARCH; dx++) {
        const r = residual(imgs[0], imgs[i], SIZE, CROP, dx, dy);
        if (r < best) { best = r; bx = dx; by = dy; }
      }
    }
    console.log(
      `  ${String(FRAMES[i]).padStart(5)}  ${raw.toFixed(2).padStart(6)}  ${best.toFixed(2).padStart(6)}` +
      `   ${String(`(${bx},${by})`).padStart(10)}   ${(best / Math.max(raw, 1e-6)).toFixed(3)}`,
    );
  }

  if (session.consoleErrors.length) {
    console.error(`console errors:\n  ${session.consoleErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await session.close();
}
