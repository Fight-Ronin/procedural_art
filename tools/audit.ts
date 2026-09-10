/**
 * What every knob actually does, and what tonal range every piece actually uses.
 *
 *   npx tsx tools/audit.ts               # the whole gallery
 *   npx tsx tools/audit.ts 001 004       # some of it
 *   npx tsx tools/audit.ts --size 96 --spp 2
 *
 * This exists because THE SAME TWO DIAGNOSES KEEP RECURRING, each time found by
 * eye, written into a project note, and then found again in the next piece:
 *
 *   A knob that does not reach the picture. 005's `uPack` only acted on a shape
 *     that was not the default one; 009's `uReach` was not the lever its name
 *     suggested; 012's `uSkyScale` was washed out by the lens before it could
 *     act. Each cost a sweep — nine cells rendered and compared — to discover.
 *
 *   A ramp outside the range its driver traverses. 001 coloured by fbm height,
 *     009 by heat, 008 needed its floor subtracted, 005 had a floor above the
 *     median of what it was reading and rendered as one flat cream. Four times.
 *
 * Both are measurable without looking at anything, and both are cheaper to
 * measure over twelve pieces at once than to rediscover one piece at a time.
 * The render suite already tests the first of these, for EXACTLY ONE PARAMETER
 * PER PIECE — the first float the piece declares — which is how `uPack` was
 * caught. Nothing checks the other twenty-odd.
 *
 * IT REPORTS, IT DOES NOT ASSERT. Every number here has a legitimate reason to
 * be small in some piece, and a threshold that tried to separate those cases
 * would be wrong more often than it was right. What the table is for is
 * ranking: the knob at the bottom of a piece's list is the one to look at.
 *
 * ONE KNOB AT A TIME CANNOT SEE A GATED PAIR, and the first run found the
 * example. 007 reports both bloom parameters at exactly 0.00: strength is
 * measured with threshold at its default, threshold is measured with strength
 * at its default, and if either default switches the effect off then BOTH read
 * as dead while the pair together is perfectly alive. That is why the default
 * is printed in every row — a zero next to a default of 0 is a gate, a zero
 * next to a default in the middle of the range is a disconnected knob, and the
 * table has to let you tell those apart. Measuring pairs instead would be
 * quadratic in the parameter count for a case that reading the column catches.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ParamSpec } from '../visualization/params/schema.ts';
import { srgbToHex } from '../visualization/params/schema.ts';
import { launch, ROOT, type Session } from './session.ts';

const args = process.argv.slice(2);
const ids = args.filter((a, i) => /^\d{3}$/.test(a) && !(i > 0 && args[i - 1].startsWith('--')));
const flag = (name: string, dflt: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const SIZE = flag('size', 96);
const SPP = flag('spp', 2);
/** Tonal statistics want less noise than a sensitivity delta does. */
const TONE_SIZE = flag('tone-size', 200);
const TONE_SPP = flag('tone-spp', 6);
/**
 * How far a stateful piece is allowed to be run before it is measured.
 *
 * A cap, not a target, and the first run is why it exists. Using each piece's
 * own `poster.frame` meant 003 stepping its reaction-diffusion field 150 times
 * for EVERY ONE of the eighty renders a parameter table needs, and 011 stepping
 * three passes 260 times; 003 alone had not finished after twenty minutes.
 *
 * The frame only has to be late enough that the pattern EXISTS — a
 * reaction-diffusion field at frame 0 is undifferentiated noise and a parameter
 * that shapes it has nothing to act on, which is the whole reason not to use
 * frame 0. It does not have to be the frame the poster was composed at. Every
 * stateful piece here declares a reference frame of 40 or less, so 60 is past
 * all of them with room to spare, at a quarter of the cost.
 */
const MAX_FRAME = flag('max-frame', 60);

interface Piece { id: string; dir: string; frame: number }

function pieces(): Piece[] {
  return readdirSync(path.join(ROOT, 'artwork'))
    .filter((d) => /^\d{3}-/.test(d))
    .map((d) => {
      const meta = JSON.parse(
        readFileSync(path.join(ROOT, 'artwork', d, 'meta.json'), 'utf8'),
      ) as { id: string; poster?: { frame?: number } };
      // The piece's own WORKING frame, read from meta.json rather than from a
      // table here. `test/render.test.ts` keeps a per-piece override table and
      // the project has already lost a block of work to two sessions editing
      // it; a list every piece must appear in exactly once is the shape that
      // collides. `poster.frame` is where a piece already says when it is
      // worth looking at, and discovery beats registration.
      //
      // 60 rather than 0 for the pieces that declare nothing: a stateless piece
      // at frame 0 has uTime = 0, so every parameter that only acts THROUGH
      // TIME — a spin rate, a drift speed — measures as doing nothing at all,
      // and would be reported dead when it is merely not started yet. Frame 60
      // costs a stateless piece exactly one different uniform.
      const want = meta.poster?.frame || 60;
      return { id: meta.id, dir: path.join('artwork', d), frame: Math.min(want, MAX_FRAME) };
    })
    .filter((p) => !ids.length || ids.includes(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The two values a knob is compared between: a quarter and three quarters of
 * its declared range.
 *
 * NOT "the default against the midpoint", which is what the render suite does.
 * That comparison is vacuous for any piece whose default happens to BE the
 * midpoint — the two renders are then the same render, the delta is exactly
 * zero, and it reads identically to a knob that is genuinely disconnected. No
 * piece sits there today (measured; the closest is 003, at 6% of its range) but
 * it is one edit away and nothing would say so. A fixed pair of points inside
 * the range cannot degenerate.
 */
function endpoints(spec: ParamSpec): { lo: unknown; hi: unknown; how: string } | null {
  switch (spec.kind) {
    case 'float': {
      const lo = spec.min + (spec.max - spec.min) * 0.25;
      const hi = spec.min + (spec.max - spec.min) * 0.75;
      return { lo, hi, how: `${lo.toPrecision(3)} -> ${hi.toPrecision(3)}` };
    }
    case 'int': {
      let lo = Math.round(spec.min + (spec.max - spec.min) * 0.25);
      let hi = Math.round(spec.min + (spec.max - spec.min) * 0.75);
      // A narrow integer range can round both quarters to the same value, which
      // would report a real knob as dead. Fall back to the full range.
      if (lo === hi) { lo = spec.min; hi = spec.max; }
      return { lo, hi, how: `${lo} -> ${hi}` };
    }
    case 'enum': {
      const first = spec.options[0].value;
      const last = spec.options[spec.options.length - 1].value;
      if (first === last) return null;
      return { lo: first, hi: last, how: `${spec.options[0].label} -> ${spec.options[spec.options.length - 1].label}` };
    }
    case 'toggle':
      return { lo: false, hi: true, how: 'off -> on' };
    case 'color': {
      // Two colours far apart in every channel, so a colour that only feeds one
      // channel still registers. The piece's own default is not one of them on
      // purpose: half the point is to see the knob move at all.
      const lo = '#204080';
      const hi = '#e0c040';
      return { lo, hi, how: `${srgbToHex(spec.def)} : blue -> gold` };
    }
    case 'vec': {
      const lo = new Array(spec.dims).fill(spec.min + (spec.max - spec.min) * 0.25);
      const hi = new Array(spec.dims).fill(spec.min + (spec.max - spec.min) * 0.75);
      return { lo, hi, how: `all ${lo[0].toPrecision(3)} -> ${hi[0].toPrecision(3)}` };
    }
  }
}

async function renderWith(
  s: Session, name: string, value: unknown, size: number, frame: number, spp: number,
): Promise<{ bytes: Uint8Array; applied: unknown; refused: string | null }> {
  const miss = await s.page.evaluate(
    (v: Record<string, unknown>) => window.__pa.loadValues(v), { [name]: value });
  const applied = await s.page.evaluate((n: string) => window.__pa.snapshot()[n], name);
  const refused = miss.unknown.length ? 'unknown'
    : miss.changed.length ? 'clamped' : null;
  const raw = await s.page.evaluate(
    ({ n, f, k }: { n: number; f: number; k: number }) => window.__pa.renderAt(n, n, f, k),
    { n: size, f: frame, k: spp });
  return { bytes: Uint8Array.from(raw), applied, refused };
}

/** Mean absolute difference over RGB, in 0..255. */
function meanDelta(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return sum / n;
}

/**
 * What range of tone and colour the picture actually occupies.
 *
 * Measured on the DISPLAYED bytes rather than in linear light, because the
 * question is what a viewer can distinguish, and that is what the sRGB encode
 * is for. A ramp that has collapsed shows up here as a narrow luminance span, a
 * low chroma, or both — 005 rendering as one flat cream was `span` small and
 * `chroma` near zero while looking, in isolation, like a palette problem.
 */
function tone(bytes: Uint8Array): {
  p1: number; p50: number; p99: number; span: number;
  clipLo: number; clipHi: number; chroma: number; chromaP99: number;
} {
  const lum: number[] = [];
  const chr: number[] = [];
  let clipLo = 0;
  let clipHi = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i], g = bytes[i + 1], b = bytes[i + 2];
    // Rec.709 on the encoded values: a perceptual weighting, not a photometric
    // one, which is the right choice for "can this be told apart".
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum.push(y);
    chr.push(Math.max(r, g, b) - Math.min(r, g, b));
    if (r <= 1 && g <= 1 && b <= 1) clipLo++;
    if (r >= 254 && g >= 254 && b >= 254) clipHi++;
  }
  lum.sort((x, y) => x - y);
  chr.sort((x, y) => x - y);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
  const p1 = q(lum, 0.01), p50 = q(lum, 0.5), p99 = q(lum, 0.99);
  return {
    p1, p50, p99, span: p99 - p1,
    clipLo: (100 * clipLo) / lum.length,
    clipHi: (100 * clipHi) / lum.length,
    chroma: chr.reduce((a, b) => a + b, 0) / chr.length,
    chromaP99: q(chr, 0.99),
  };
}

const s = await launch(5281);
try {
  for (const p of pieces()) {
    await s.open(`?p=${p.id}`);
    const err = await s.page.evaluate(() => window.__pa.error);
    if (err) {
      console.log(`\n${p.id}  FAILED TO COMPILE\n${err}`);
      continue;
    }
    const specs = await s.page.evaluate(() => window.__pa.store.specs) as ParamSpec[];

    const base = Uint8Array.from(await s.page.evaluate(
      ({ n, f, k }: { n: number; f: number; k: number }) => window.__pa.renderAt(n, n, f, k),
      { n: TONE_SIZE, f: p.frame, k: TONE_SPP }));
    const t = tone(base);

    console.log(`\n\x1b[1m${p.dir}\x1b[0m  frame ${p.frame}`);
    console.log(`  tone   lum p1/p50/p99 ${t.p1.toFixed(0)}/${t.p50.toFixed(0)}/${t.p99.toFixed(0)}` +
      `  span ${t.span.toFixed(0)}  clipped ${t.clipLo.toFixed(1)}% low ${t.clipHi.toFixed(1)}% high` +
      `  chroma mean ${t.chroma.toFixed(1)} p99 ${t.chromaP99.toFixed(0)}`);

    const rows: { name: string; label: string; delta: number; how: string; note: string; def: string }[] = [];
    for (const spec of specs) {
      const e = endpoints(spec);
      if (!e) continue;
      const a = await renderWith(s, spec.name, e.lo, SIZE, p.frame, SPP);
      const b = await renderWith(s, spec.name, e.hi, SIZE, p.frame, SPP);
      // Restore, so the next parameter is measured against this piece's own
      // look rather than against whatever the last knob was left at.
      await s.page.evaluate(
        (v: Record<string, unknown>) => window.__pa.loadValues(v),
        { [spec.name]: spec.kind === 'color' ? `#${srgbToHex(spec.def)}` : spec.def });
      const note = a.refused || b.refused
        ? ` [${a.refused ?? b.refused}: ${JSON.stringify(a.applied)} / ${JSON.stringify(b.applied)}]`
        : '';
      const def = spec.kind === 'color' ? `#${srgbToHex(spec.def)}`
        : spec.kind === 'toggle' ? String(spec.def)
        : spec.kind === 'vec' ? spec.def.join(',')
        : String(spec.def);
      rows.push({ name: spec.name, label: spec.label, delta: meanDelta(a.bytes, b.bytes), how: e.how, note, def });
    }

    rows.sort((x, y) => y.delta - x.delta);
    for (const r of rows) {
      const dim = r.delta < 0.5 ? '\x1b[31m' : r.delta < 2 ? '\x1b[33m' : '';
      const end = dim ? '\x1b[0m' : '';
      console.log(`  ${dim}${r.delta.toFixed(2).padStart(7)}${end}  ${r.name.padEnd(20)} ` +
        `def ${r.def.padEnd(9)} ${r.how}${r.note}`);
    }
  }
} finally {
  await s.close();
}
