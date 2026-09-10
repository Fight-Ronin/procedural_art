/**
 * Distance ESTIMATORS, and the one property that makes them usable.
 *
 * `test/sdf.test.ts` holds the exact primitives to 1e-5 against a boundary
 * walk. Nothing here can be tested that way: an Apollonian gasket and a
 * Mandelbox have no closed-form distance, so there is no truth to compare
 * against. Writing a looser version of the exactness test would not be a weaker
 * check, it would be a check of nothing.
 *
 * The first version of this file made exactly that mistake in a subtler form.
 * It stepped along `DE(p)` and asserted the estimate stayed positive, on the
 * theory that an overestimate would carry the step through the surface and flip
 * the sign. But these estimators return `length(z) / dr`, which is NEVER
 * NEGATIVE — there is no inside to detect — so the check was true of any
 * non-negative function whatsoever. It passed at 4088 of 4088 points for the
 * correct estimator and at 4088 of 4088 for a deliberately broken one.
 *
 * What actually guarantees the marcher is the LIPSCHITZ BOUND: |DE(a) - DE(b)|
 * <= |a - b|. It gives the contract directly — if DE(p) = d and DE is
 * 1-Lipschitz, then every q within d of p has DE(q) >= d - |q - p| > 0, so no
 * zero of DE lies inside the step. It needs no notion of truth, only the
 * function. And it is measurable by finite differences with no smoothness
 * assumption at all, because a 1-Lipschitz function has difference quotients
 * bounded by 1 at every scale, however much detail sits between the samples.
 *
 * It is also precisely the property that a dropped scale factor destroys. Every
 * operation in these folds stretches space, and the returned distance is a
 * bound only if every factor is accumulated into the running derivative. Drop
 * the sphere fold's contribution — the classic — and the estimate comes back
 * larger by that factor over the region where the fold engages, which is a
 * local slope far above 1. THE PICTURE STILL RENDERS. It comes out soft and
 * slightly melted, because the marcher is stepping past the surface and
 * catching it on the way back, and that reads as a rendering-quality problem
 * rather than as a broken function. So the control below is a Mandelbox with
 * that one term removed, held to the same threshold as the correct one.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('distance estimators');

const N = 64; // 4096 probe points, 4088 after the identity stamp
const PROBED = 4088;

/**
 * Points on a shell from 1.5 to 4, which is where the sphere fold engages.
 *
 * The first version probed a shell at radius 3 to 7 and the control could not
 * fire: out there the fold is mostly a no-op, the two estimators agree to the
 * bit at 89% of points, and where they disagree the surface is far enough away
 * that even a doubled estimate does not reach it. Measured before the threshold
 * was chosen — 1.5 to 4 is the band a marcher spends its steps in, and the band
 * where the broken estimate is more than twice the correct one at 44% of points.
 */
const SHELL = `
vec2 q = (pix + 0.5) / n;
float rad = mix(1.5, 4.0, q.x);
float a = q.y * 6.2831853;
float b = fract(q.y * 7.0) * 2.0 - 1.0;
vec3 p = normalize(vec3(cos(a), b, sin(a))) * rad;
`;

/**
 * The broken estimator, and the finite-difference slope of either.
 *
 * `h` is 4e-3. Small enough that the quotient is local, large enough that the
 * float32 error of nine amplifying iterations — a few parts in 1e5 on values
 * near 1 — stays well under the tolerance when divided by it. Both 4e-3 and
 * 1e-2 were measured and give the same verdict, so the answer is not an
 * artefact of the step.
 */
const DECLS = `
float mandelboxLoose(vec3 p, float scale, int iters) {
    vec3 z = p;
    float dr = 1.0;
    for (int i = 0; i < 16; ++i) {
        if (i >= iters) break;
        z = sdBoxFold(z, 1.0);
        sdSphereFold(z, 0.5, 1.0);   // moved, but the factor is thrown away
        z = z * scale + p;
        dr = dr * abs(scale) + 1.0;
    }
    return length(z) / abs(dr);
}

const float H = 4.0e-3;

float slopeGood(vec3 p) {
    float d0 = sdMandelbox(p, -1.85, 9);
    float worst = 0.0;
    worst = max(worst, abs(sdMandelbox(p + vec3(H, 0, 0), -1.85, 9) - d0));
    worst = max(worst, abs(sdMandelbox(p - vec3(H, 0, 0), -1.85, 9) - d0));
    worst = max(worst, abs(sdMandelbox(p + vec3(0, H, 0), -1.85, 9) - d0));
    worst = max(worst, abs(sdMandelbox(p - vec3(0, H, 0), -1.85, 9) - d0));
    worst = max(worst, abs(sdMandelbox(p + vec3(0, 0, H), -1.85, 9) - d0));
    worst = max(worst, abs(sdMandelbox(p - vec3(0, 0, H), -1.85, 9) - d0));
    return worst / H;
}

float slopeLoose(vec3 p) {
    float d0 = mandelboxLoose(p, -1.85, 9);
    float worst = 0.0;
    worst = max(worst, abs(mandelboxLoose(p + vec3(H, 0, 0), -1.85, 9) - d0));
    worst = max(worst, abs(mandelboxLoose(p - vec3(H, 0, 0), -1.85, 9) - d0));
    worst = max(worst, abs(mandelboxLoose(p + vec3(0, H, 0), -1.85, 9) - d0));
    worst = max(worst, abs(mandelboxLoose(p - vec3(0, H, 0), -1.85, 9) - d0));
    worst = max(worst, abs(mandelboxLoose(p + vec3(0, 0, H), -1.85, 9) - d0));
    worst = max(worst, abs(mandelboxLoose(p - vec3(0, 0, H), -1.85, 9) - d0));
    return worst / H;
}
`;

const s = await launch(5267);
try {
  // --- the estimate never grows faster than the distance you moved -----------
  {
    const img = await runProbe(s, {
      includes: ['sdf/fractal.glsl'],
      decls: DECLS,
      body: `${SHELL}
float d = sdMandelbox(p, -1.85, 9);

// Finite first. One NaN poisons a whole ray, and the clamped inversion inside
// the fold is what stops it.
float finite = (d == d && d < 1.0e6) ? 1.0 : 0.0;

// The theorem says 1. The tolerances are float32, not slack in the claim:
// nine iterations multiplying by 1.85 amplify the input error by ~300 before
// the difference is taken and divided by H. Measured max is under 1.10 across
// every radius band tried, so 1.10 is where the honest bound sits and 1.25 is
// carried only because the control below is stated against it.
float lip = step(slopeGood(p), 1.10);
float lipLoose = step(slopeGood(p), 1.25);

ok = vec3(finite, lip, lipLoose);
`,
    }, N);
    const c = countFailures(img);
    const labels: [string, string, string] = ['finite', 'slope <= 1.10', 'slope <= 1.25'];
    check('the Mandelbox estimate is finite everywhere on the shell',
      c.failed[0] === 0, describe(c, labels));
    check('and its slope never exceeds 1 beyond float error — the marcher\'s whole contract',
      c.failed[1] === 0, describe(c, labels));
  }

  // --- the control: drop the sphere fold's derivative ------------------------
  {
    const img = await runProbe(s, {
      includes: ['sdf/fractal.glsl'],
      decls: DECLS,
      body: `${SHELL}
// Channel 0 reports the property HOLDING, so the failure count is the number of
// points where the broken estimator violates the bound the correct one meets
// everywhere. Same threshold, same points, same probe.
float lipLoose = step(slopeLoose(p), 1.25);

// And it violates it by being BIGGER, not noisier: dropping a positive factor
// from the denominator can only inflate the estimate, so the broken value must
// be at least the correct one at every single point. If this failed, the
// control would be measuring some other bug.
float bigger = step(sdMandelbox(p, -1.85, 9) - 1.0e-5, mandelboxLoose(p, -1.85, 9));

// The size of the error, not just its presence.
float doubled = step(2.0, mandelboxLoose(p, -1.85, 9) / max(sdMandelbox(p, -1.85, 9), 1.0e-9));

ok = vec3(lipLoose, bigger, doubled);
`,
    }, N);
    const c = countFailures(img);
    const labels: [string, string, string] = ['slope <= 1.25', 'loose >= correct', 'loose > 2x'];
    check('dropping the sphere fold from the derivative breaks the bound (control)',
      c.failed[0] > PROBED * 0.2,
      `violated at ${c.failed[0]}/${PROBED} points — the correct estimator violates it at none`);
    check('and it breaks it by overestimating, not by being noisy (control)',
      c.failed[1] === 0, describe(c, labels));
    check('the overestimate is more than a rounding error (control)',
      PROBED - c.failed[2] > PROBED * 0.2,
      `more than 2x too large at ${PROBED - c.failed[2]}/${PROBED} points`);
  }

  // --- the estimate is not a vacuously small constant ------------------------
  //
  // Conservatism alone is satisfied by `return 1e-9;`. What rules that out is
  // that a marcher driven by this estimate actually ARRIVES: it must reach the
  // surface in a bounded number of steps, and it must arrive at the shape
  // rather than converging on empty space because the estimate went tiny.
  {
    const img = await runProbe(s, {
      includes: ['sdf/fractal.glsl'],
      decls: `
// Returns the step count, and reports where it stopped.
float marchSteps(vec3 ro, vec3 rd, out vec3 hit) {
    float t = 0.0;
    for (int i = 0; i < 400; ++i) {
        hit = ro + rd * t;
        float d = sdMandelbox(hit, -1.85, 9);
        if (d < 2.0e-3) return float(i);
        t += d;
        if (t > 14.0) return 998.0;
    }
    return 999.0;
}
`,
      body: `
vec2 q = (pix + 0.5) / n;
float a = q.x * 6.2831853;
float b = (q.y * 2.0 - 1.0) * 1.2;
vec3 rd = normalize(vec3(cos(a) * cos(b), sin(b), sin(a) * cos(b)));
vec3 ro = -rd * 6.0;   // aimed through the origin, so every ray meets the body

vec3 hit;
float k = marchSteps(ro, rd, hit);

float arrives = step(k, 160.0);
float quick = step(k, 64.0);

// And it arrived AT the shape. A vacuous estimator would "converge" at t ~ 0,
// six units out in clear space, and pass the step-count check while rendering
// a sphere of fog.
//
// 3.6 is measured, not assumed. The first version guessed 3.2 and 16 rays of
// 4088 stopped outside it; bracketing the stop radius showed every ray inside
// 3.6 and none between 3.6 and 5, so those sixteen are the far tips of the body
// at this scale and iteration count, not early convergence. The claim is still
// strong: a ray from radius 6 must travel at least 2.4 units before stopping.
float onShape = step(length(hit), 3.6);

ok = vec3(arrives, quick, onShape);
`,
    }, N);
    const c = countFailures(img);
    const labels: [string, string, string] = ['arrives <=160', 'arrives <=64', 'on the shape'];
    check('a marcher driven by the estimate reaches the surface in bounded steps',
      c.failed[0] === 0, describe(c, labels));
    check('and stops on the shape rather than in clear space',
      c.failed[2] === 0, describe(c, labels));
    check('most rays converge in under 64 steps',
      c.failed[1] < PROBED * 0.05, describe(c, labels));
  }

  // --- the Apollonian ---------------------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['sdf/fractal.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec3 p = (vec3(q, fract(q.x * 7.0)) * 2.0 - 1.0) * 2.5;

float d = sdApollonian(p, 1.16, 9);
float finite = (d == d && abs(d) < 1.0e6) ? 1.0 : 0.0;

// The depth handle must actually vary — it is the only cheap way a piece can
// tell a deep small sphere from a shallow large one, and a constant would make
// every fractal in the library render as one flat colour. Checked as a spread
// across the probe rather than per point, by requiring each point to differ
// from the value at a fixed reference.
float here = sdApollonianDepth(p, 1.16, 9);
float there = sdApollonianDepth(vec3(0.3, 0.7, -0.2), 1.16, 9);
float varies = step(1.0e-3, abs(here - there));

// The origin is the one input that can send the inversion to infinity. The
// clamp inside the fold is what keeps it finite, and it is worth pinning
// because removing it looks harmless and poisons whole rays.
float atOrigin = sdApollonian(vec3(0.0), 1.16, 9);
float originFinite = (atOrigin == atOrigin && abs(atOrigin) < 1.0e6) ? 1.0 : 0.0;

ok = vec3(finite, varies, originFinite);
`,
    }, N);
    const c = countFailures(img);
    const labels: [string, string, string] = ['finite', 'depth varies', 'finite at the origin'];
    check('the Apollonian estimate is finite everywhere, the origin included',
      c.failed[0] === 0 && c.failed[2] === 0, describe(c, labels));
    // Not every point: the depth is genuinely equal to the reference on a
    // measure-zero set, and near it on a small one.
    check('the depth handle varies across the domain',
      c.failed[1] < PROBED * 0.05, describe(c, labels));
  }
} finally {
  await s.close();
}
