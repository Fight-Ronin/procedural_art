/**
 * End-to-end in a real WebGL2 context, for every piece: it compiles on a
 * driver, renders something, contains no NaN, honours the resolution-
 * independence contract, and responds to its declared parameters. Also writes
 * each piece's poster, and checks that preset capture reaches meta.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, ORIGIN } from './browser.ts';
import { check, note, section } from './harness.ts';
import { ROOT } from './paths.ts';

interface PieceCheck {
  id: string;
  dir: string;
  /** Base resolution; the comparison also renders this times `ratio`. */
  small: number;
  ratio: number;
  /** Samples per pixel for the comparison renders. */
  spp: number;
  /**
   * Both images are box-reduced to this many pixels per side before diffing.
   *
   * The contract being tested is "the same picture at any size", not "the same
   * bytes". A stochastic piece (002 samples one wavelength per sample) differs
   * pixel-by-pixel between resolutions purely from Monte Carlo variance, which
   * is high-frequency and vanishes under reduction — while a real coupling, a
   * fixed marching epsilon or a hardcoded pixel width, shifts structure and
   * brightness and survives it. Reducing separates the two.
   */
  compare: number;
  tolerance: number;
  /** Poster: rendered the way export will, as short accumulated draws. */
  poster: number;
  posterDraws: number;
  posterSpp: number;
  /**
   * Stateful pieces: the frame to check the simulation at, and the frame the
   * poster shows. Frame N means N simulation steps since seeding — there is no
   * separate "simulation frames" knob any more, precisely so that a sequence
   * render and a standalone render of frame N cannot disagree.
   */
  simFrame?: number;
  posterFrame: number;
}

const CHECKS: PieceCheck[] = [
  {
    id: '001', dir: 'artwork/001-drift',
    small: 300, ratio: 3, spp: 1, compare: 60, tolerance: 3,
    poster: 900, posterDraws: 6, posterSpp: 4, posterFrame: 0,
  },
  {
    // Refractive raymarching on SwiftShader is slow; small numbers, and a
    // looser bound because the spectral sampling is stochastic.
    id: '002', dir: 'artwork/002-vitreous',
    small: 132, ratio: 3, spp: 3, compare: 33, tolerance: 6,
    poster: 512, posterDraws: 12, posterSpp: 4, posterFrame: 0,
  },
  {
    // The most expensive piece per sample: every one of its ~28 integration
    // steps evaluates a curl (three octaves of analytic-derivative noise) and a
    // Worley lookup. Small numbers throughout, and spp 1 — its supersampling
    // buys antialiasing rather than convergence, since nothing in it is
    // stochastic.
    id: '004', dir: 'artwork/004-silt',
    small: 132, ratio: 3, spp: 1, compare: 33, tolerance: 4,
    poster: 420, posterDraws: 4, posterSpp: 2, posterFrame: 0,
  },
  {
    // The first opaque lit piece, and the slowest per sample: ridged 3D noise
    // at every march step, plus AO and a soft shadow that each re-evaluate the
    // displaced field. Everything here is scaled to that.
    id: '005', dir: 'artwork/005-scarp',
    small: 100, ratio: 3, spp: 1, compare: 25, tolerance: 5,
    poster: 280, posterDraws: 2, posterSpp: 2, posterFrame: 0,
  },
  {
    // Stateful. The simulation grid is fixed at 384 texels on the short side,
    // so both resolutions in the comparison read the SAME field — which is the
    // whole point of sizing passes absolutely rather than as a fraction of the
    // display.
    id: '003', dir: 'artwork/003-coalesce',
    small: 256, ratio: 3, spp: 1, compare: 64, tolerance: 4,
    poster: 768, posterDraws: 4, posterSpp: 2, posterFrame: 150,
    simFrame: 20,
  },
];

// `npm test -- render 003` narrows to one piece; iterating on a slow stateful
// simulation through the full suite is otherwise unbearable.
const only = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
const ACTIVE = only.length ? CHECKS.filter((c) => only.includes(c.id)) : CHECKS;

section('render');

const h = await launch();

for (const c of ACTIVE) {
  await h.open(`?p=${c.id}`);

  const err = await h.page.evaluate(() => window.__pa.error);
  if (!check(`${c.id} compiles on a real driver`, !err, err ?? '')) {
    console.log(err);
    continue;
  }
  check(`${c.id} is the piece under test`,
    (await h.page.evaluate(() => window.__pa.piece)) === c.id);

  if (c.simFrame) {
    const t = Date.now();
    const info = await h.page.evaluate(
      ({ n, f }: { n: number; f: number }) => {
        const before = window.__pa.renderAt(n, n, 0, 1);
        const after = window.__pa.renderAt(n, n, f, 1);
        let sum = 0;
        for (let i = 0; i < before.length; i += 4) sum += Math.abs(after[i] - before[i]);
        return { passes: window.__pa.passes, delta: sum / (before.length / 4) };
      },
      { n: c.small, f: c.simFrame },
    );
    check(`${c.id} declares a simulation pass`, info.passes.length > 0, info.passes.join(', '));
    check(`${c.id} the simulation evolves`, info.delta > 2,
      `frame 0 vs frame ${c.simFrame} differ by mean ${info.delta.toFixed(1)}/255 ` +
        `in ${((Date.now() - t) / 1000).toFixed(1)}s`);

    // Feedback is a pure function of (seed, frame): ask for the same frame
    // twice and the field has to land in exactly the same place. Without this a
    // stateful piece could never carry a reference image. Because renderAt now
    // re-seeds and re-steps on every call, this also covers the seek path
    // itself — which is what a sequence render and a still render share.
    const repeat = await h.page.evaluate(
      ({ n, f }: { n: number; f: number }) => {
        const first = window.__pa.renderAt(n, n, f, 1);
        const second = window.__pa.renderAt(n, n, f, 1);
        let max = 0;
        for (let i = 0; i < first.length; i++) max = Math.max(max, Math.abs(first[i] - second[i]));
        return { max, nan: second.some((v) => Number.isNaN(v)) };
      },
      { n: c.small, f: Math.min(c.simFrame, 12) },
    );
    check(`${c.id} the same frame renders identically twice`, repeat.max === 0,
      `max channel difference ${repeat.max}`);
    check(`${c.id} the simulation stays bounded`, !repeat.nan);

    // Stepping forward one frame at a time must land where seeking straight to
    // that frame lands. This is THE sequence invariant: a video renders by
    // stepping, a still re-derives by seeking, and the two have to agree
    // bit-for-bit or frame N of the video is not the frame the print shows.
    const walk = await h.page.evaluate(
      ({ n, f }: { n: number; f: number }) => {
        window.__pa.seekTo(n, n, 0);
        for (let i = 0; i < f; i++) window.__pa.advanceFrame(1);
        const stepped = window.__pa.renderTile(n, n, { x: 0, y: 0, w: n, h: n }, f, 1, 1);
        const sought = window.__pa.renderAt(n, n, f, 1);
        let max = 0;
        for (let i = 0; i < sought.length; i++) {
          max = Math.max(max, Math.abs(stepped[i] - sought[i]));
        }
        return { max, at: window.__pa.simStep };
      },
      { n: c.small, f: Math.min(c.simFrame, 12) },
    );
    check(`${c.id} stepping to frame N equals seeking to frame N`, walk.max === 0,
      `max channel difference ${walk.max} (simulation left at step ${walk.at})`);
  }

  const stats = await h.page.evaluate(
    ({ n, spp }: { n: number; spp: number }) => {
      const px = window.__pa.renderAt(n, n, 0, spp);
      let min = 255;
      let max = 0;
      for (let i = 0; i < px.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          const v = px[i + k];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      return { min, max, nan: px.some((v) => Number.isNaN(v)) };
    },
    { n: c.small, spp: c.spp },
  );
  check(`${c.id} frame is not blank`, stats.max - stats.min > 30, JSON.stringify(stats));
  check(`${c.id} has no NaN`, !stats.nan);

  const diff = await h.page.evaluate(
    ({ n, k, spp, cmp }: { n: number; k: number; spp: number; cmp: number }) => {
      const reduce = (px: number[], size: number, out: number): number[] => {
        const f = size / out;
        const acc = new Float64Array(out * out * 3);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const oy = Math.min(out - 1, Math.floor(y / f));
            const ox = Math.min(out - 1, Math.floor(x / f));
            for (let ch = 0; ch < 3; ch++) acc[(oy * out + ox) * 3 + ch] += px[(y * size + x) * 4 + ch];
          }
        }
        const per = f * f;
        return Array.from(acc, (v) => v / per);
      };
      const a = reduce(window.__pa.renderAt(n, n, 0, spp), n, cmp);
      const b = reduce(window.__pa.renderAt(n * k, n * k, 0, spp), n * k, cmp);
      let sum = 0;
      let max = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        sum += d;
        if (d > max) max = d;
      }
      return { mean: sum / a.length, max };
    },
    { n: c.small, k: c.ratio, spp: c.spp, cmp: c.compare },
  );
  check(`${c.id} is resolution independent (mean < ${c.tolerance}/255)`,
    diff.mean < c.tolerance,
    `${c.small}px vs ${c.small * c.ratio}px reduced to ${c.compare}px: ` +
      `mean ${diff.mean.toFixed(2)}  max ${diff.max.toFixed(1)}`);

  // At the piece's own working frame, not frame 0: a reaction-diffusion field
  // at frame 0 is undifferentiated noise, and a parameter that shapes the
  // pattern has almost nothing to act on yet. Measuring there made this pass by
  // 18% — a threshold that close to the value is a test waiting to flake.
  const paramEffect = await h.page.evaluate(
    ({ n, f }: { n: number; f: number }) => {
      const spec = window.__pa.store.specs.find((s) => s.kind === 'float');
      if (!spec) return { name: null as string | null, delta: 0, count: 0 };
      const base = window.__pa.renderAt(n, n, f, 1);
      const mid = ((spec.min ?? 0) + (spec.max ?? 1)) * 0.5;
      window.__pa.setParam(spec.name, mid === 0 ? (spec.max ?? 1) : mid * 1.6);
      const next = window.__pa.renderAt(n, n, f, 1);
      let sum = 0;
      for (let i = 0; i < base.length; i += 4) sum += Math.abs(next[i] - base[i]);
      return {
        name: spec.name,
        delta: sum / (base.length / 4),
        count: window.__pa.store.specs.length,
      };
    },
    { n: Math.min(c.small, 160), f: c.simFrame ?? 0 },
  );
  check(`${c.id} declares parameters`, paramEffect.count >= 5, `${paramEffect.count} parameters`);
  check(`${c.id} a parameter changes the image`, paramEffect.delta > 0.5,
    `${paramEffect.name}: mean red delta ${paramEffect.delta.toFixed(2)}`);

  // The accumulation contract: one draw of N samples must equal N draws of one.
  // This is what makes progressive refinement converge to the image the
  // exporter would produce, and it only holds because paSample is a global
  // ordinal rather than an index within the draw — restart the sequence per
  // draw and the same total sample count lands somewhere else entirely.
  await h.open(`?p=${c.id}`);
  const equiv = await h.page.evaluate((n: number) => {
    const one = window.__pa.renderAt(n, n, 0, 8);
    const many = window.__pa.accumulateAt(n, n, 0, 8, 1);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < one.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(one[i + ch] - many[i + ch]);
        sum += d;
        if (d > max) max = d;
      }
    }
    return { mean: sum / ((one.length / 4) * 3), max, format: window.__pa.format,
             samples: window.__pa.samples };
  }, Math.min(c.small, 160));
  check(`${c.id} accumulation equals a single multi-sample draw`, equiv.mean < 1,
    `mean ${equiv.mean.toFixed(3)}  max ${equiv.max}  (${equiv.format}, ${equiv.samples} samples)`);

  // Fresh load so the poster uses declared defaults, not the nudged parameter.
  await h.open(`?p=${c.id}`);
  const t0 = Date.now();
  // Accumulated rather than one big draw — the same shape the exporter will
  // use, and each draw stays far short of the driver's watchdog timeout. The
  // seek to posterFrame happens inside accumulateAt; a stateful piece has to be
  // run forward before it is worth looking at.
  await h.page.evaluate(
    ({ n, d, spp, f }: { n: number; d: number; spp: number; f: number }) =>
      window.__pa.accumulateAt(n, n, f, d, spp),
    { n: c.poster, d: c.posterDraws, spp: c.posterSpp, f: c.posterFrame },
  );
  const url = await h.page.evaluate(() => window.__pa.dataURL());
  const out = path.join(ROOT, c.dir, 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'poster.png'), Buffer.from(url.split(',')[1], 'base64'));
  note(`${c.dir}/out/poster.png — ${c.poster}px, frame ${c.posterFrame}, ` +
    `${c.posterDraws} x ${c.posterSpp} = ${c.posterDraws * c.posterSpp} samples, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// --- preset capture writes into meta.json ------------------------------------
{
  const metaPath = path.join(ROOT, 'artwork/001-drift/meta.json');
  const before = readFileSync(metaPath, 'utf8');
  const res = await fetch(`${ORIGIN}/__pa/preset`, {
    method: 'POST',
    body: JSON.stringify({
      entry: 'artwork/001-drift/main.frag',
      name: '__test__',
      values: { uWarp: 1.23 },
    }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  const after = JSON.parse(readFileSync(metaPath, 'utf8')) as {
    presets: { name: string; values: Record<string, number> }[];
  };
  const saved = after.presets.find((p) => p.name === '__test__');
  check('capture writes a preset into meta.json',
    json.ok && saved?.values.uWarp === 1.23, json.error ?? JSON.stringify(saved));
  writeFileSync(metaPath, before); // leave the repo as we found it
}

check('no console errors', h.consoleErrors.length === 0, h.consoleErrors.join('\n'));

await h.close();
