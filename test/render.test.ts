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
import { pieceRefs } from '../tools/ref.ts';
import { reduceLinear } from '../tools/tone.ts';

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
  /**
   * The frame every check that only wants "the piece as it actually looks" runs
   * at — is it blank, does a parameter reach the image. Derived, never written
   * in the table.
   *
   * SEPARATE FROM `simFrame` because `simFrame` answers a different question.
   * `simFrame` means "this piece has a simulation, examine it here", and the
   * four stateful checks are guarded on it. Using the same field for "where to
   * look at the picture" made the second meaning conditional on the first, so a
   * STATELESS piece was always examined at frame 0 — with the comment "for the
   * rest, frame 0 is the picture", which was true right up until a stateless
   * piece had a parameter that only acts through time. 001 is now that piece:
   * its flow offsets are zero at t = 0 by construction, so a check at frame 0
   * would read a working knob as dead. Third time in this repo, and the second
   * time inside the fix for the second time.
   */
  workFrame: number;
}

/**
 * Per-piece overrides. Everything not named here takes DEFAULTS below.
 *
 * IT USED TO BE THE WHOLE LIST, and that was a silent hole: this suite, export
 * and sequence each carried a hardcoded array, so a new piece got no
 * resolution-independence check, no tiled-identity check and no step/seek
 * check, and nothing said so — the totals simply did not move. Exactly the
 * second-registry problem `test/pieces.test.ts` had when 004 was added, except
 * that one went red and these three went quiet, which is worse. Discovered
 * while adding 007: seven pieces, six covered.
 *
 * The entries stay because they carry real per-piece knowledge — a marcher's
 * tolerance, a simulation's frame, why 006 needs a looser bound. What changed
 * is that absence from this table means "ordinary", not "untested".
 */
const OVERRIDES: (Partial<PieceCheck> & { id: string })[] = [
  {
    // 008 integrates a volume at up to 128 steps per ray, which makes it the
    // most expensive piece here by a wide margin — the defaults would put the
    // suite's poster render alone into the minutes. Small numbers, and a looser
    // per-cell bound because the march start is jittered per sample, so at two
    // samples the residual is honest Monte Carlo noise rather than a coupling.
    id: '008',
    small: 90, ratio: 3, spp: 2, compare: 30, tolerance: 7,
    poster: 320, posterDraws: 2, posterSpp: 2, posterFrame: 0,
  },
  {
    // Every pixel integrates a geodesic — up to 192 Runge-Kutta steps, four
    // metric evaluations each, before one colour is looked up — which makes it
    // the most expensive piece here, roughly five times 008 per sample.
    //
    // `small` IS 120 RATHER THAN 90, AND THE REASON IS THE PIECE'S ONE REAL
    // RESOLUTION DEPENDENCE. Its sky is a field of point sources, and a point
    // source seen through a bounded display transform cannot be
    // resolution-stable: a pixel that half-covers a star of radiance 1.5
    // averages to 0.75 and is compressed gently, while at three times the size
    // the same star fills a pixel, is compressed hard, and its neighbours are
    // black. Reducing those two back to a common grid does not give the same
    // number, and no amount of sampling makes it — measured, by tripling spp
    // from 2 to 6: the per-cell difference fell 1.43 -> 1.12 (that part IS
    // Monte Carlo) while the overall LEVEL rose 0.59 -> 0.90, converging onto
    // the bias rather than away from it. The same experiment 006 ran, with the
    // same conclusion in the opposite direction.
    //
    // Isolated before it was fixed, rather than assumed: with uMode 1 (flat
    // classification colours, no sky at all) the same comparison gives a level
    // of 0.10. The geodesics and the fractal winding at the critical angle are
    // not the problem; the sky was.
    //
    // So it is fixed at the source. The piece's light now comes from an
    // EXTENDED field — a ridged-noise nebula on the celestial sphere — with the
    // point sources demoted to dim punctuation, which puts the level at
    // 0.14/255 against the hard limit of 1.0. That constraint improved the
    // picture as well as the number: bending a high-frequency star field just
    // makes more high frequency and reads as noise, while a SMOOTH field folded
    // by the map generates the fine structure itself, and the accordion of
    // rings at the critical angle becomes the same nebula seen a dozen times.
    //
    // What is still open is print. A star cannot be both small and hot until
    // its angular size follows the pixel footprint THROUGH the lensing map —
    // and that magnification is the same number that makes an Einstein ring
    // bright, so it is one quantity buying both. Next block; until then, no
    // bloom, because nothing here is hot enough to have any (008's lesson).
    //
    // Per-cell mean measured at 1.31, so the tolerance is the repo default of 3
    // rather than something chosen for this piece.
    id: '012',
    small: 120, ratio: 3, spp: 3, compare: 30, tolerance: 3,
    poster: 240, posterDraws: 1, posterSpp: 2, posterFrame: 0,
  },
  {
    // posterFrame follows meta.json's poster.frame: 001's flow offsets are zero
    // at t = 0, so a poster at frame 0 is the one picture the piece can make
    // that does not show what it now does. Free here — nothing to step.
    id: '001',
    small: 300, ratio: 3, spp: 1, compare: 60, tolerance: 3,
    poster: 900, posterDraws: 6, posterSpp: 4, posterFrame: 240,
  },
  {
    // Refractive raymarching on SwiftShader is slow; small numbers, and a
    // looser bound because the spectral sampling is stochastic.
    id: '002',
    small: 132, ratio: 3, spp: 3, compare: 33, tolerance: 6,
    poster: 512, posterDraws: 12, posterSpp: 4, posterFrame: 0,
  },
  {
    // The most expensive piece per sample: every one of its ~28 integration
    // steps evaluates a curl (three octaves of analytic-derivative noise) and a
    // Worley lookup. Small numbers throughout, and spp 1 — its supersampling
    // buys antialiasing rather than convergence, since nothing in it is
    // stochastic.
    id: '004',
    small: 132, ratio: 3, spp: 1, compare: 33, tolerance: 4,
    poster: 420, posterDraws: 4, posterSpp: 2, posterFrame: 0,
  },
  {
    // The first opaque lit piece, and the slowest per sample: ridged 3D noise
    // at every march step, plus AO and a soft shadow that each re-evaluate the
    // displaced field. Everything here is scaled to that.
    id: '005',
    small: 100, ratio: 3, spp: 1, compare: 25, tolerance: 5,
    poster: 280, posterDraws: 2, posterSpp: 2, posterFrame: 0,
  },
  {
    // Cheap SDF, expensive volumetric — the opposite trade from 005, and worth
    // having both in the net because they stress different things.
    // The loosest per-cell tolerance in the suite, and the reason is measured
    // rather than assumed: at spp 1 the difference was 5.66, and at spp 3 it was
    // 5.62. Tripling the samples moved it by 0.04, so it is NOT Monte Carlo
    // variance from the volumetric jitter — that was the first hypothesis and
    // the experiment refused it.
    //
    // HALF OF IT WAS THE TEST. 006 sat at an overall level shift of 5.62/255
    // that tripling the sample count barely moved, which ruled out Monte Carlo
    // variance and was left unexplained. The cause was this suite reducing in
    // sRGB: the encode is concave, so a bimodal patch averages darker than a
    // smooth one carrying the same light, and 006 is bright columns against a
    // dark vault. Reducing in linear light instead put it at 0.52.
    //
    // A THIRD OF IT WAS ALSO THE TEST, found later. 110 does not divide into 27
    // cells, so the reduction's cell boundaries fell at 4.55% of the image
    // height on the small render and 3.94% on the large one, and drifted apart
    // across the grid — every cell compared a slightly different strip of a
    // picture made of thin vertical columns. 006 was the only piece in the
    // suite with a non-dividing pair, which is why it alone looked bad.
    // `reduceLinear` now refuses that outright; 110 into 22 cells is exact on
    // both sides (5px boxes and 15px boxes over identical regions).
    //
    // What remains is real: this piece has the thinnest geometry in the repo —
    // hex prism columns and a slender ring seen at a distance — and both the
    // marching tolerance and the normal epsilon are scaled by the pixel
    // footprint on purpose, so a 110px render genuinely resolves those edges
    // differently from a 330px one. That is cone tracing working, not failing.
    // The per-cell bound has come down 7 -> 6 -> 4 as each measurement error
    // left it; the observed value is 2.22.
    id: '006',
    small: 110, ratio: 3, spp: 3, compare: 22, tolerance: 4,
    poster: 300, posterDraws: 2, posterSpp: 2, posterFrame: 0,
  },
  {
    // Stateful, and the slowest simulation in the repo: 320x320 agents each
    // sensing three bilinear taps, plus a 3x3 blur over a 640x640 trail, every
    // step. Small numbers everywhere, and a working frame far from zero because
    // the network needs a couple of hundred steps to exist at all.
    id: '011',
    small: 120, ratio: 3, spp: 1, compare: 30, tolerance: 4,
    poster: 420, posterDraws: 2, posterSpp: 2, posterFrame: 260,
    simFrame: 150,
  },
  {
    // Stateful. The simulation grid is fixed at 384 texels on the short side,
    // so both resolutions in the comparison read the SAME field — which is the
    // whole point of sizing passes absolutely rather than as a fraction of the
    // display.
    id: '003',
    small: 256, ratio: 3, spp: 1, compare: 64, tolerance: 4,
    poster: 768, posterDraws: 4, posterSpp: 2, posterFrame: 150,
    simFrame: 20,
  },
];

/**
 * A piece nobody wrote an entry for. Deliberately modest and deliberately
 * strict: a new piece is checked at a real tolerance from the day it exists,
 * and tightening or loosening it is then a decision someone makes on purpose.
 */
const DEFAULTS = {
  small: 200, ratio: 3, spp: 2, compare: 50, tolerance: 3,
  poster: 700, posterDraws: 4, posterSpp: 3, posterFrame: 0,
};

/**
 * The frame a stateful piece is examined at, DISCOVERED rather than registered.
 *
 * It used to come only from an explicit `simFrame` in the table above, so a
 * stateful piece nobody added an entry for was silently examined at frame 0 —
 * and 010 was exactly that piece. Two consequences, both invisible: the
 * "simulation evolves" check never ran for it at all (it is guarded on
 * `simFrame`), and the parameter check ran at a frame where the piece's
 * accumulator holds a single deposit. That second one surfaced when 010 gained
 * a `uDecay` declaration in its image pass, making retention the first float
 * the check picks: at frame 0 there is no history to retain, so a working knob
 * measured 0.00 and read exactly like a dead one.
 *
 * `poster.frame` is where a piece already declares when it is worth looking at,
 * so it is the honest default. Capped, because this frame is paid on EVERY
 * render the check makes and the poster frame can be 260 steps of a three-pass
 * simulation; the frame only has to be late enough that the piece exists. An
 * explicit entry still wins, which is how 003 and 011 keep their cheaper ones.
 *
 * THE CAP IS A COST CAP ON SIMULATION STEPS, so it applies to stateful pieces
 * only. Seeking a stateless piece to frame 240 sets a uniform and costs nothing,
 * and paying nothing for the frame the piece itself nominates is strictly better
 * than paying nothing for frame 0.
 */
const SIM_FRAME_CAP = 60;

const CHECKS: PieceCheck[] = pieceRefs().map((p) => {
  const over = OVERRIDES.find((o) => o.id === p.id) ?? { id: p.id };
  const meta = JSON.parse(
    readFileSync(path.join(ROOT, p.dir, 'meta.json'), 'utf8'),
  ) as { passes?: unknown[]; poster?: { frame?: number } };
  const stateful = (meta.passes?.length ?? 0) > 0;
  const poster = meta.poster?.frame ?? 0;
  // Where to LOOK at the piece — every piece has an answer to that, stateful or
  // not. An explicit simFrame still wins, since it was chosen to be cheap.
  const workFrame = over.simFrame ?? (stateful ? Math.min(poster, SIM_FRAME_CAP) : poster);
  // Whether there is a SIMULATION to examine — only stateful pieces have one,
  // and the four stateful checks are guarded on this being set.
  const simFrame = stateful ? workFrame || undefined : undefined;
  return { ...DEFAULTS, dir: p.dir, ...over, simFrame, workFrame } as PieceCheck;
});

section('render');

// The table may only name pieces that exist: a renamed or deleted directory
// would otherwise leave an override that silently applies to nothing.
{
  // The reduction compares two renders cell by cell, which is only meaningful
  // if a cell covers the same region of the picture in both. That needs
  // `compare` to divide `small` exactly — `ratio` is an integer, so dividing
  // the small side divides the large one too. 006 spent two rounds of
  // investigation looking like a resolution-dependent artwork because of a pair
  // that did not (110 into 27); `reduceLinear` refuses it now, but a refusal
  // that surfaces as a crashed suite is a worse report than this line.
  const misaligned = CHECKS
    .filter((c) => c.small % c.compare !== 0)
    .map((c) => `${c.id}: ${c.small} / ${c.compare}`);
  check('every comparison reduces onto an aligned cell grid', misaligned.length === 0,
    misaligned.join('; ') || CHECKS.map((c) => `${c.id} ${c.small}/${c.compare}`).join('  '));

  const ghosts = OVERRIDES.filter((o) => !CHECKS.some((c) => c.id === o.id)).map((o) => o.id);
  check('every render override names a real piece', ghosts.length === 0, ghosts.join(', '));
  note(`${CHECKS.length} pieces, ${OVERRIDES.length} with overrides`);
}

// `npm test -- render 003` narrows to one piece; iterating on a slow stateful
// simulation through the full suite is otherwise unbearable.
const only = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
const ACTIVE = only.length ? CHECKS.filter((c) => only.includes(c.id)) : CHECKS;

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

  // AT THE PIECE'S WORKING FRAME, like the parameter check below and for the
  // same reason. "Is there a picture here" asked at frame 0 of a stateful piece
  // is asking before the piece has one: 011's trail map is seeded empty, so
  // frame 0 is a uniform dark field and the check reports a blank artwork that
  // is working perfectly. 003 happened to pass only because a reaction-diffusion
  // is seeded with noise, which has contrast by accident rather than by design.
  const stats = await h.page.evaluate(
    ({ n, spp, f }: { n: number; spp: number; f: number }) => {
      const px = window.__pa.renderAt(n, n, f, spp);
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
    { n: c.small, spp: c.spp, f: c.workFrame },
  );
  check(`${c.id} frame is not blank`, stats.max - stats.min > 30, JSON.stringify(stats));
  check(`${c.id} has no NaN`, !stats.nan);

  // Both renders happen in the page; the arithmetic happens HERE.
  //
  // It used to be a closure passed to page.evaluate, and that closure named its
  // helpers — which the TypeScript loader rewrites to reference an `__name`
  // helper that does not exist in the browser. The suite aborted at this line
  // with `ReferenceError: __name is not defined`, taking 54 unrelated checks
  // with it, and `run.ts`'s crash guard is the only reason the rest of the run
  // survived. Pixel arithmetic has no reason to be in the page: render there,
  // reduce here.
  const small = await h.page.evaluate(
    ({ n, spp }: { n: number; spp: number }) => window.__pa.renderAt(n, n, 0, spp),
    { n: c.small, spp: c.spp },
  );
  const large = await h.page.evaluate(
    ({ n, spp }: { n: number; spp: number }) => window.__pa.renderAt(n, n, 0, spp),
    { n: c.small * c.ratio, spp: c.spp },
  );
  const a = reduceLinear(small, c.small, c.compare);
  const b = reduceLinear(large, c.small * c.ratio, c.compare);

  let sum = 0;
  let max = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
    ma += a[i];
    mb += b[i];
  }
  // Overall brightness of each, which is the STRUCTURAL claim. Per-cell
  // differences can be legitimate: cone tracing resolves a surface to the
  // precision the output can show, so a small render genuinely lacks detail a
  // large one has, and reduction averages that detail rather than removing it.
  // What must NOT differ is the picture's overall level — a marching tolerance
  // or a normal epsilon coupled to resolution in the wrong way shifts that, and
  // no amount of reduction hides it.
  const diff = { mean: sum / a.length, max, level: Math.abs(ma - mb) / a.length };

  const detail = `${c.small}px vs ${c.small * c.ratio}px reduced to ${c.compare}px: ` +
    `mean ${diff.mean.toFixed(2)}  max ${diff.max.toFixed(1)}  ` +
    `overall level differs by ${diff.level.toFixed(2)}/255`;
  check(`${c.id} is resolution independent (mean < ${c.tolerance}/255)`,
    diff.mean < c.tolerance, detail);
  // The tighter, and more meaningful, half. Local detail may differ; the
  // picture's level may not.
  check(`${c.id} renders at the same overall level at both resolutions`,
    diff.level < 1.0, detail);

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
    { n: Math.min(c.small, 160), f: c.workFrame },
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

  // THIS BLOCK USED TO ASSERT NOTHING. It posted the capture, read the file
  // back, found the entry — and then fell straight into the next section
  // without a single check(), so the whole endpoint was untested while looking
  // tested. It also never restored the file, which is why 001's committed
  // meta.json carried a preset named `__test__` for weeks: the suite's own
  // debris, shipped in the repo, and indistinguishable at a glance from a look
  // somebody meant to keep.
  check('capturing a preset writes it into the piece meta.json',
    json.ok && saved !== undefined, json.error ?? `presets: ${after.presets.map((p) => p.name).join(', ')}`);
  check('and the captured values survive the round trip',
    saved?.values.uWarp === 1.23, JSON.stringify(saved?.values ?? null));

  // Restored unconditionally, byte for byte. A test that leaves a committed
  // file modified makes every later `git status` lie about what changed.
  writeFileSync(metaPath, before);
  check('and the test leaves the piece meta.json exactly as it found it',
    readFileSync(metaPath, 'utf8') === before);
  // --- bloom actually blooms -------------------------------------------------
  //
  // A piece that declares bloom must visibly differ with it turned off. Without
  // this, a regression that silently zeroed the strength — a mis-set uniform, a
  // halo never bound, a threshold nothing clears — would pass every other check
  // in the suite, because the reference images would simply be regenerated
  // around it.
  //
  // Three pieces declare one — 006, 008 and 009 — and what they have in common
  // is the finding: bloom needs radiance above 1, which means a source IN THE
  // FRAME. A piece lit by an environment does not have any, and 002 and 005
  // were both tried and measured flat. 006 demonstrated the converse the hard
  // way: moving its lamp out of shot dropped its bloom delta from 15.97 to
  // 0.24, because the lamp WAS the thing above the threshold.
  {
    const withBloom = pieceRefs().filter((p) => {
      const m = JSON.parse(readFileSync(path.join(ROOT, p.dir, 'meta.json'), 'utf8'));
      return (m.display?.bloom?.strength ?? 0) > 0;
    });
    note(`${withBloom.length} of ${pieceRefs().length} pieces declare bloom`);
    for (const p of withBloom) {
      await h.open(`?p=${p.id}`);
      const px = async (strength: number) => {
        await h.page.evaluate(
          (v: number) => window.__pa.setParam('uBloomStrength', v), strength);
        return h.page.evaluate(() => window.__pa.renderAt(120, 120, 0, 2));
      };
      const on = await px(-1); // clamps to the spec's minimum, which is 0
      const off = await px(0);
      const dflt = JSON.parse(readFileSync(path.join(ROOT, p.dir, 'meta.json'), 'utf8'))
        .display.bloom.strength as number;
      const lit = await px(dflt);
      let diff = 0;
      for (let i = 0; i < lit.length; i += 4) diff += Math.abs(lit[i] - off[i]);
      const mean = diff / (lit.length / 4);
      check(`${p.id} bloom changes the image`, mean > 1.0, `mean red delta ${mean.toFixed(2)}`);
      let same = 0;
      for (let i = 0; i < on.length; i += 4) same += Math.abs(on[i] - off[i]);
      check(`${p.id} zero strength costs nothing`, same === 0,
        `clamped-to-zero vs zero: ${same}`);
    }
  }

  check('capture writes a preset into meta.json',
    json.ok && saved?.values.uWarp === 1.23, json.error ?? JSON.stringify(saved));
  writeFileSync(metaPath, before); // leave the repo as we found it
}

check('no console errors', h.consoleErrors.length === 0, h.consoleErrors.join('\n'));

await h.close();
