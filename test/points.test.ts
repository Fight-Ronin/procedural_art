/**
 * The scatter pass: what is new about drawing points instead of a triangle.
 *
 * Most of what a point pass must satisfy is already covered by discovery — the
 * export suite checks that 010 tiles bit-identically, the render suite that it
 * is resolution independent, the sequence suite that frame N means N steps.
 * Those matter a great deal and they cost nothing extra, which is the payoff
 * for building the pass as a chain pass rather than as a special case.
 *
 * What is left is the handful of properties that only a scatter pass has, and
 * they are all consequences of one decision: THE DEPOSIT TARGET IS CLEARED
 * EVERY STEP. Persistence is a downstream buffer pass's job. The alternative —
 * letting the points blend into a target nobody clears — is one fewer buffer
 * and it works perfectly for about a day, until something asks the chain to run
 * a different number of times than it used to. A still that seeks, a sequence
 * that steps, a tile plan, a resumed video and a preview would then all disagree
 * about how many points are in the picture, and every one of them would look
 * plausible on its own.
 *
 * That failure is invisible in a single image, so it is measured rather than
 * looked at.
 */
import { launch } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('scatter passes');

const s = await launch(5229);
try {
  await s.open('?p=010');
  const err = await s.page.evaluate(() => window.__pa.error);
  if (err) throw new Error(`010 failed to compile:\n${err}`);

  const passes = await s.page.evaluate(() => window.__pa.passes);
  check('the piece declares a point pass and an accumulation pass',
    passes.length === 2, passes.join(', '));

  // Retention 1.0 makes the accumulation a plain running total, so the image
  // pass's divide by frame count leaves DENSITY STATIONARY: each frame adds one
  // frame's worth of orbits and the divisor grows in step. If the deposit
  // target leaked between steps, frame N would deposit N frames' worth and the
  // level would climb with the frame number instead of settling.
  //
  // THE FIRST VERSION OF THIS CHECK DID NOT CATCH THAT, and only breaking the
  // renderer on purpose revealed it. The piece maps density through
  // log(1 + gain*d), which at the default gain of 90 compresses a fourfold
  // change into about 12% of level — comfortably inside any tolerance loose
  // enough to allow the genuine Monte Carlo settling between 8 frames' worth of
  // orbits and 32. The check read as a strong statement about the clear and was
  // in fact a statement about the logarithm.
  //
  // So the measurement is moved into a regime where it is sensitive: gain 1 and
  // gamma 1 make the tone nearly linear in density, and the vignette and speed
  // tint are turned off so nothing else varies. Measured both ways at frames 8,
  // 16, 32 and 64 — correct: 26.635, 26.603, 26.629, 26.638 (spread 0.035);
  // leaking: 37.08, 41.08, 44.99, 48.46 (spread 11.4). A factor of three
  // hundred between the two, and the signature is not "four times brighter" but
  // "climbs monotonically where it should be flat".
  await s.page.evaluate(() => {
    window.__pa.stopLoop();
    window.__pa.setParam('uDecay', 1.0);
    window.__pa.setParam('uGain', 1.0);
    window.__pa.setParam('uGamma', 1.0);
    window.__pa.setParam('uVignette', 0.0);
    window.__pa.setParam('uSpeedTint', 0.0);
  });

  const meanAt = async (frame: number): Promise<number> => {
    const px = await s.page.evaluate(
      (f: number) => {
        window.__pa.seekTo(96, 96, f);
        return window.__pa.renderAt(96, 96, f, 1);
      },
      frame,
    );
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i];
    return sum / (px.length / 4);
  };

  {
    const frames = [8, 16, 32, 64];
    const levels: number[] = [];
    for (const f of frames) levels.push(await meanAt(f));
    const spread = Math.max(...levels) - Math.min(...levels);
    const detail = frames.map((f, i) => `f${f} ${levels[i].toFixed(3)}`).join('  ') +
      `  spread ${spread.toFixed(3)}/255`;
    note(detail);
    check('the deposit is cleared each step, so density is stationary in frame count',
      spread < 0.5, `${detail} — a leaking deposit climbs monotonically (measured 11.4)`);
    // Stated separately because it is the diagnostic half: a spread caused by
    // Monte Carlo settling wanders, a spread caused by a leak only ever goes up.
    const climbing = levels.every((v, i) => i === 0 || v > levels[i - 1]);
    check('and the level does not climb with the frame number',
      !(climbing && spread > 0.2), detail);
  }

  // Additive float blending is order-dependent arithmetic, and the order is
  // gl_VertexID. That it is REPRODUCIBLE is what every bit-identity guarantee
  // in this repo rests on once a scatter pass is in the chain: tiled export,
  // golden references, and a sequence resume all assume rendering the same
  // frame twice gives the same bytes.
  {
    const a = await s.page.evaluate(() => {
      window.__pa.seekTo(96, 96, 12);
      return window.__pa.renderAt(96, 96, 12, 1);
    });
    const b = await s.page.evaluate(() => {
      window.__pa.seekTo(96, 96, 12);
      return window.__pa.renderAt(96, 96, 12, 1);
    });
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    check('re-deriving the same frame gives byte-identical pixels',
      diff === 0, `${diff} of ${a.length} bytes differ`);
  }

  // The deposit grid is absolutely sized, like every other simulation target,
  // and that is the whole reason a tile never observes the point pass. Checked
  // here directly rather than only through the reduced comparison in the render
  // suite: the two output sizes must read the SAME accumulated field, so the
  // difference between them is resampling and nothing else.
  {
    const small = await s.page.evaluate(() => {
      window.__pa.seekTo(120, 120, 16);
      return window.__pa.renderAt(120, 120, 16, 1);
    });
    const large = await s.page.evaluate(() => {
      window.__pa.seekTo(360, 360, 16);
      return window.__pa.renderAt(360, 360, 16, 1);
    });
    let sa = 0;
    for (let i = 0; i < small.length; i += 4) sa += small[i];
    sa /= small.length / 4;
    let sb = 0;
    for (let i = 0; i < large.length; i += 4) sb += large[i];
    sb /= large.length / 4;
    note(`red mean: 120px = ${sa.toFixed(2)}, 360px = ${sb.toFixed(2)}`);
    // A deposit grid tied to the output would put 9x the points per texel into
    // the small render and change its level outright.
    check('the deposit grid is absolute, so output size does not change the field',
      Math.abs(sa - sb) < 2.0, `120px ${sa.toFixed(2)} vs 360px ${sb.toFixed(2)} /255`);
  }
} finally {
  await s.close();
}
