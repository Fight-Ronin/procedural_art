/**
 * Light on curved paths, checked against the things that are true of it.
 *
 * This is the first module in `basics/` whose output is not a number you could
 * look at and doubt — it is a TRAJECTORY, and a wrong one is not a blurry
 * picture but a perfectly sharp picture of a different spacetime. Every failure
 * mode here renders beautifully:
 *
 *   a sign error in dp_l/dxi bends light the wrong way — the wormhole becomes a
 *     lens instead of a window and nothing in the frame says so;
 *   a slope computed by finite difference instead of analytically is smooth,
 *     plausible, and slightly the wrong shape everywhere;
 *   an integrator that quietly loses accuracy shows up as a sky that shifts
 *     when the step count changes, which reads as "the preview was rougher".
 *
 * So the suite is built out of quantities with exact values: an invariant that
 * is conserved identically, a segment of the metric where the solution is
 * closed form, a limit in which the spacetime is flat and the ray is a straight
 * line, an angle whose value is rho/r in closed form, and time reversal.
 *
 * EVERY THRESHOLD BELOW WAS MEASURED, in a 32-bit float model of exactly these
 * configurations, before it was written down; the measured value is in each
 * check's detail line so the margin is visible rather than implied. Two of them
 * were badly wrong on the first guess, which is the argument for having done it:
 * the accuracy probe's grid originally included near-critical rays, where h=0.4
 * under-resolves a ray that is winding and the residual measures the step size
 * rather than the integrator; and the Euler control was vacuous over part of
 * that grid, because for b -> 0 the system is dl/dxi = p_l with dp_l/dxi = 0 and
 * FORWARD EULER IS EXACT.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('metric');

const s = await launch(5231);
try {
  // --- the shape: r, its slope, and the two properties that make it legal ----
  {
    const img = await runProbe(s, {
      includes: ['metric/wormhole.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
// A whole family at once: throat length sweeps 0 (a zero-length Ellis-like
// throat) to 6 down the image, so the mouth lands in different places and the
// guard below is live rather than decorative.
float len = mix(0.0, 6.0, uv.y);
float cyl = len * 0.5;
MtWormhole w = mtWormhole(1.0, len, 0.6);
float l = mix(-9.0, 9.0, uv.x);
float e = 4.0e-3;

float r = mtRadius(l, w);
float sl = mtSlope(l, w);
float num = (mtRadius(l + e, w) - mtRadius(l - e, w)) / (2.0 * e);

// r' is continuous at the mouth but r'' jumps there, so a central difference
// straddling it is not the derivative of anything. Reported as a pass rather
// than tested, which is honest; the join itself is checked by the exactness of
// the cylinder below.
bool mouth = abs(abs(l) - cyl) < 3.0 * e;
float slope = mouth ? 1.0 : step(abs(num - sl), 1.0e-3);

// FLARE-OUT. |dr/dl| < 1 is what makes the embedding profile
// dz/dl = sqrt(1 - (dr/dl)^2) real — a shape violating it is not a wormhole
// drawn wrong, it is not a surface.
float flare = step(abs(sl), 0.99999);

// Inside the cylinder the radius is EXACTLY rho and the slope EXACTLY zero,
// not nearly: both come from a branch, not from a formula that happens to
// evaluate small. Outside, r must have left rho behind.
float cylinder = abs(l) <= cyl
    ? ((r == 1.0 && sl == 0.0) ? 1.0 : 0.0)
    : (abs(abs(l) - cyl) < 0.01 ? 1.0 : step(1.0e-6, r - 1.0));

ok = vec3(slope, flare, cylinder);
`,
    }, 64);
    const c = countFailures(img);
    check('mtSlope is the derivative of mtRadius (analytic vs central difference)',
      c.failed[0] === 0,
      describe(c, ['slope matches to 1e-3', 'flare-out |r\'| < 1', 'cylinder is exact']));
    check('|dr/dl| < 1 everywhere, so the throat is an embeddable surface',
      c.failed[1] === 0, describe(c, ['slope', 'flare-out', 'cylinder']));
    check('inside the throat r is exactly rho and the slope exactly zero',
      c.failed[2] === 0, describe(c, ['slope', 'flare-out', 'cylinder']));
  }

  // --- the integrator, against forward Euler ---------------------------------
  //
  // The band is chosen, not swept: b/rho in [1.3, 3] puts the turning point
  // comfortably outside the throat. Near-critical rays are excluded ON PURPOSE
  // — there a fixed h = 0.4 under-resolves a ray winding around the throat, so
  // the residual would measure the step size rather than the integrator, and
  // the threshold would be describing the wrong thing. What the near-critical
  // regime actually does is measured in the last probe, where it belongs.
  {
    const img = await runProbe(s, {
      includes: ['metric/geodesic.glsl'],
      decls: `
// The control: the same system advanced by forward Euler. It is the version
// anyone writes first, it is stable at these step sizes, and it produces a
// picture — a wrong one.
vec3 euler1(vec3 y, float h, float b, MtWormhole w) {
    return y + h * mtGeoDeriv(y, b, w);
}
`,
      body: `
vec2 uv = (pix + 0.5) / n;
MtWormhole w = mtWormhole(1.0, 3.0, 0.6);
float b = mix(1.3, 3.0, uv.x);            // = b/rho, since rho is 1
float l0 = mix(5.0, 9.0, uv.y);
float sinA = b / mtRadius(l0, w);
vec3 y0 = vec3(l0, 0.0, -sqrt(max(1.0 - sinA * sinA, 0.0)));

vec3 y = y0;
for (int i = 0; i < 60; ++i) mtGeoStep(y, 0.4, b, w);
float rk = mtGeoNull(y, b, w);

vec3 z = y0;
for (int i = 0; i < 60; ++i) z = euler1(z, 0.4, b, w);
float eu = mtGeoNull(z, b, w);

// Fourth order, over the same span: 15 steps of 1.6 against 30 of 0.8. Second
// order would give 4x, third 8x, fourth 16x; the measured minimum here is 12.
vec3 a = y0;
for (int i = 0; i < 15; ++i) mtGeoStep(a, 1.6, b, w);
vec3 cc = y0;
for (int i = 0; i < 30; ++i) mtGeoStep(cc, 0.8, b, w);

ok = vec3(step(rk, 1.0e-4),
          step(0.05, eu),
          step(8.0 * mtGeoNull(cc, b, w), mtGeoNull(a, b, w)));
`,
    }, 32);
    const c = countFailures(img);
    check('mtGeoStep conserves the null invariant (measured worst 1.2e-5, held to 1e-4)',
      c.failed[0] === 0, describe(c, ['rk4 within 1e-4', 'euler is not (control)', 'halving h gains > 8x']));
    check('forward Euler at the same step count does NOT (control: measured 0.24, needs > 0.05)',
      c.failed[1] === 0, describe(c, ['rk4', 'euler control', 'order']));
    check('halving the step gains more than 8x, so the step is above third order',
      c.failed[2] === 0, describe(c, ['rk4', 'euler control', 'order']));
    note('over ALL angles including near-critical the worst residual is 3.7e-3, not 1.2e-5 — that is the step size, not the integrator');
  }

  // --- the two places the answer is known exactly ----------------------------
  {
    const img = await runProbe(s, {
      includes: ['metric/geodesic.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
MtWormhole w = mtWormhole(1.0, 3.0, 0.6);   // cylinder is |l| <= 1.5

// INSIDE THE CYLINDER THE SOLUTION IS CLOSED FORM. r is constant there, so
// r' is zero, so dp_l/dxi is zero and both l and psi are linear in xi:
//     p_l unchanged,  psi = (b / rho^2) * xi
// Forty steps of 0.05 is a span of exactly 2, and every ray below stays inside.
float b = mix(0.05, 0.95, uv.x);            // b/rho: strictly through, no turning
float pl0 = -sqrt(1.0 - b * b);
vec3 y = vec3(1.35, 0.0, pl0);
for (int i = 0; i < 40; ++i) mtGeoStep(y, 0.05, b, w);
float sweep = step(abs(y.y - 2.0 * b), 1.0e-5);
// Not "close to": r' is exactly 0 there, so every k in the Runge-Kutta sum has
// a zero third component and p_l cannot move at all.
float held = (y.z == pl0) ? 1.0 : 0.0;

// TIME REVERSAL. Integrating with -h undoes +h; anything that is not the
// integrator — a sign error in the derivative, an asymmetry in the tableau —
// fails to come back.
float m = mix(1.3, 3.0, uv.y);
float sA = m / mtRadius(7.0, w);
vec3 r0 = vec3(7.0, 0.0, -sqrt(max(1.0 - sA * sA, 0.0)));
vec3 rr = r0;
for (int i = 0; i < 40; ++i) mtGeoStep(rr, 0.3, m, w);
for (int i = 0; i < 40; ++i) mtGeoStep(rr, -0.3, m, w);
vec3 d = abs(rr - r0);
float back = step(max(max(d.x, d.y), d.z), 2.0e-4);

ok = vec3(sweep, held, back);
`,
    }, 32);
    const c = countFailures(img);
    check('inside the throat the sweep matches the closed form (measured 8e-7, held to 1e-5)',
      c.failed[0] === 0, describe(c, ['sweep is (b/rho^2) xi', 'p_l exactly unchanged', 'reversal returns']));
    check('inside the throat p_l does not move by a single bit',
      c.failed[1] === 0, describe(c, ['sweep', 'p_l held', 'reversal']));
    check('integrating with -h returns to the start (measured 2.1e-5, held to 2e-4)',
      c.failed[2] === 0, describe(c, ['sweep', 'p_l held', 'reversal']));
  }

  // --- flat space, and the control that stops it being vacuous ---------------
  //
  // As rho and the lensing width go to zero, r(l) -> |l| and the metric is
  // ordinary flat space in spherical coordinates, where the ray is a straight
  // line and satisfies r sin(psi + alpha) = b at EVERY point along it — no exit
  // test, no asymptotics, an identity available after any number of steps.
  //
  // On its own that check passes for a stepper that does nothing at all: leave
  // psi at 0 and r at r0 and the identity is r0 sin(alpha) = b, which is the
  // definition of b. So the same expression is evaluated on the REAL wormhole
  // in the same probe and required to be violated. Without that second channel
  // the first one is decoration.
  {
    const img = await runProbe(s, {
      includes: ['metric/geodesic.glsl'],
      decls: `
float straightness(MtWormhole w, float l0, float sinA) {
    float r0 = mtRadius(l0, w);
    float b = r0 * sinA;
    float alpha = asin(clamp(sinA, -1.0, 1.0));
    vec3 y = vec3(l0, 0.0, -sqrt(max(1.0 - sinA * sinA, 0.0)));
    for (int i = 0; i < 60; ++i) mtGeoStep(y, 0.25, b, w);
    return abs(mtRadius(y.x, w) * sin(y.y + alpha) - b);
}
`,
      body: `
vec2 uv = (pix + 0.5) / n;
float sinA = mix(0.1, 0.9, uv.x);
float l0 = mix(6.0, 10.0, uv.y);

// GLSL ES 3.0 makes 'flat' an interpolation qualifier, so it cannot be a
// variable name — it compiles as a syntax error one line later, which is
// where the first version of this probe spent its time.
float straight = straightness(mtWormhole(1.0e-3, 0.0, 1.0e-4), l0, sinA);
float curved   = straightness(mtWormhole(1.0, 3.0, 0.6), l0, sinA);

ok = vec3(step(straight, 8.0e-3),
          step(0.02, curved),
          (straight == straight && curved == curved) ? 1.0 : 0.0);
`,
    }, 32);
    const c = countFailures(img);
    check('in the flat limit the ray is a straight line (measured worst 2.3e-3, held to 8e-3)',
      c.failed[0] === 0, describe(c, ['flat is straight', 'the real one is not (control)', 'finite']));
    check('the same test FAILS on the real wormhole (control: measured 0.047 at least, needs > 0.02)',
      c.failed[1] === 0, describe(c, ['flat', 'control', 'finite']));
    check('neither produces NaN', c.failed[2] === 0, describe(c, ['flat', 'control', 'finite']));
  }

  // --- the critical angle, and the price of being near it --------------------
  {
    const img = await runProbe(s, {
      includes: ['metric/geodesic.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
MtWormhole w = mtWormhole(1.0, 3.0, 0.6);
float l0 = mix(2.5, 9.0, uv.y);
float crit = mtCritSin(l0, w);

// Sampled RELATIVE to the critical angle and cubed, so the columns crowd onto
// it: the closest are within 1.5e-5 of it. Sampling the angle uniformly would
// never land near the boundary and the tightness below would be untested.
float t = uv.x * 2.0 - 1.0;
float off = sign(t) * pow(abs(t), 3.0) * 0.5;
float sinA = clamp(crit * (1.0 + off), 0.001, 0.999);

float b = mtGeoImpact(l0, sinA, w);
vec3 y = vec3(l0, 0.0, -sqrt(max(1.0 - sinA * sinA, 0.0)));
bool away = false;
for (int i = 0; i < 512; ++i) {
    if (abs(y.x) > 14.0) { away = true; break; }
    mtGeoStep(y, 0.3, b, w);
}
// The prediction: crossing happens exactly when b < rho, i.e. sinA < rho/r(l0).
bool agrees = away && ((y.x < 0.0) == (sinA < crit));

ok = vec3(abs(off) > 0.02   ? (agrees ? 1.0 : 0.0) : 1.0,
          abs(off) > 0.002  ? (agrees ? 1.0 : 0.0) : 1.0,
          away ? 1.0 : 0.0);
`,
    }, 32);
    const c = countFailures(img);
    check('rays cross the throat exactly when sin(alpha) < rho/r, to 2% of the angle',
      c.failed[0] === 0, describe(c, ['agrees beyond 2%', 'agrees beyond 0.2%', 'resolved within 512 steps']));
    check('the boundary is sharp to 0.2% of the critical angle',
      c.failed[1] === 0, describe(c, ['beyond 2%', 'beyond 0.2%', 'resolved']));
    // NOT a failure: it is the piece's step-budget hazard, quantified. A ray
    // whose impact parameter is a whisker from rho winds around the throat
    // arbitrarily many times before it leaves — 35 turns at b/rho = 0.9999 —
    // so a fixed budget is always exhausted in a thin ring at exactly the
    // critical angle, and that ring sits where the eye is already looking.
    // 012 shows it under uMode 2 so it can be told apart from a real feature.
    check('only rays within 0.2% of critical exhaust a 512-step budget (measured 32 of 1024)',
      c.failed[2] < 1024 * 0.08,
      describe(c, ['beyond 2%', 'beyond 0.2%', 'resolved within budget']));
    note('worst step count among rays that did resolve: 440 of 512');
  }

  // --- the camera's transverse drift ----------------------------------------
  //
  // A camera that is not flying straight down the axis needs the angle its
  // sideways motion subtends, which is the integral of dl/r along its path.
  // Two things make it checkable without a reference value: inside the cylinder
  // r is exactly rho, so the trapezoid is EXACT there rather than convergent;
  // and r is never smaller than rho anywhere, so the result can never exceed
  // what a path entirely inside the throat would give.
  {
    const img = await runProbe(s, {
      includes: ['metric/wormhole.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
MtWormhole w = mtWormhole(1.0, 3.0, 0.6);      // cylinder is |l| <= 1.5
int steps = int(mix(8.0, 64.0, uv.y));

// Entirely inside the cylinder, where r is the constant rho and the trapezoid
// has nothing to approximate.
float a = mix(-1.45, 0.0, uv.x);
float b = mix(0.0, 1.45, fract(uv.x * 3.0));
float inside = step(abs(mtDrift(a, b, w, steps) - (b - a) / 1.0), 1.0e-5);

// The bound, everywhere: r >= rho, so |integral dl/r| <= |b - a| / rho.
float c = mix(-9.0, 0.0, uv.x);
float d = mix(0.0, 9.0, fract(uv.y * 5.0 + 0.13));
float wide = mtDrift(c, d, w, steps);
float bound = step(abs(wide), abs(d - c) / 1.0 + 1.0e-5);

// ...and it must be STRICTLY less out there, or the bound above is vacuous —
// it would hold just as well for a function that ignored r entirely.
//
// ONLY where the span actually leaves the cylinder. Inside it the bound is
// attained with equality, and that is the correct answer rather than a near
// miss: demanding strictness there would be asserting the opposite of the
// exactness checked in the first channel.
float reaches = step(2.5, max(abs(c), abs(d)));
float slack = reaches > 0.5 ? step(0.05, abs(d - c) / 1.0 - abs(wide)) : 1.0;
// 1e-2 on a result of order 8, and the number is the mouth's doing: a
// symmetric span agrees to 8e-4 between 32 and 64 steps, while the spans
// with one endpoint near |l| = cyl — where r'' jumps — need the whole
// allowance. Guessed at 2e-3 first, which failed on 8% of the grid.
float conv = step(abs(mtDrift(c, d, w, 32) - mtDrift(c, d, w, 64)), 1.0e-2);

ok = vec3(inside, bound * conv, slack);
`,
    }, 48);
    const c = countFailures(img);
    check('inside the throat mtDrift is exact, not merely convergent',
      c.failed[0] === 0, describe(c, ['exact in the cylinder', 'bounded, and converged by 64 steps', 'strictly less outside']));
    check('mtDrift never exceeds the throat value, and has converged by 64 steps',
      c.failed[1] === 0, describe(c, ['exact', 'bound + converged', 'strict outside']));
    check('and is strictly under it outside the throat (control)',
      c.failed[2] === 0, describe(c, ['exact', 'bound + converged', 'strict outside']));
  }

  // --- the lensing magnification --------------------------------------------
  //
  // `mtLensMag` claims that the solid angle a pixel covers is stretched by
  // (sin Psi / sin theta) |dPsi/dtheta|. That is a derivation, and the way to
  // check a derivation is to measure the thing it derives: trace the corners of
  // a small quadrilateral, build them as 3-vectors on both spheres, and take
  // the areas directly. Nothing in that measurement uses the formula.
  {
    const img = await runProbe(s, {
      includes: ['metric/geodesic.glsl'],
      decls: `
float traceP(float l0, float th, MtWormhole w) {
    float b = mtGeoImpact(l0, sin(th), w);
    vec3 y = vec3(l0, 0.0, -cos(th));
    for (int i = 0; i < 400; ++i) {
        if (abs(y.x) > 14.0) break;
        mtGeoStep(y, 0.25, b, w);
    }
    return y.y + mtGeoTail(y, b, w);
}
/** A direction at polar angle p and azimuth a, on either sphere. */
vec3 onSphere(float p, float a) {
    return vec3(sin(p) * cos(a), sin(p) * sin(a), cos(p));
}
`,
      body: `
vec2 uv = (pix + 0.5) / n;
MtWormhole w = mtWormhole(1.0, 3.0, 0.6);
float l0 = mix(4.0, 9.0, uv.y);
float crit = asin(clamp(mtCritSin(l0, w), 0.0, 1.0));
// Two bands, both kept clear of the critical angle where dPsi/dtheta diverges
// and a finite difference stops meaning anything: rays that cross, and rays
// that turn back.
float m = fract(uv.y * 2.0) < 0.5 ? mix(0.20, 0.80, uv.x) : mix(1.25, 3.00, uv.x);
float th = clamp(crit * m, 0.02, 1.45);

float e = 3.0e-3;
float p0 = traceP(l0, th, w);
float p1 = traceP(l0, th + e, w);
float formula = mtLensMag(sin(th), p0, (p1 - p0) / e);

// The independent measurement. The camera-side quad and its image, as areas of
// little parallelograms in three dimensions — the formula appears nowhere.
vec3 a0 = onSphere(th, 0.0), a1 = onSphere(th + e, 0.0), a2 = onSphere(th, e);
vec3 b0 = onSphere(p0, 0.0), b1 = onSphere(p1, 0.0), b2 = onSphere(p0, e);
float meas = length(cross(b1 - b0, b2 - b0)) / max(length(cross(a1 - a0, a2 - a0)), 1.0e-20);

float agree = step(abs(meas - formula), 0.03 * max(formula, 1.0));
// Control: the lens must actually magnify, or the agreement above is two ways
// of writing 1. Asked of the CROSSING band only — a ray that turns back sweeps
// through a magnification of 1 somewhere on its way out, so the far band
// contains a ring where being close to 1 is the right answer. (Measured: 606,
// 165 and 232 across the crossing band; 31.7, 0.14 and 1.03 across the other.)
float crossing = fract(uv.y * 2.0) < 0.5 ? 1.0 : 0.0;
float bends = crossing > 0.5 ? step(0.25, abs(formula - 1.0)) : 1.0;
float finite = (formula == formula && formula < 1.0e5) ? 1.0 : 0.0;

ok = vec3(agree, bends, finite);
`,
    }, 32);
    const c = countFailures(img);
    check('mtLensMag matches a spherical area measured from traced corners',
      c.failed[0] === 0, describe(c, ['formula vs measured area', 'the lens actually magnifies (control)', 'finite']));
    check('the magnification is far from 1, so the comparison is not vacuous (control)',
      c.failed[1] === 0, describe(c, ['agrees', 'control', 'finite']));
    check('and never returns NaN or runs away', c.failed[2] === 0,
      describe(c, ['agrees', 'control', 'finite']));
    note('near the critical angle dPsi/dtheta diverges and a difference quotient stops meaning anything; both bands stay clear of it on purpose');
  }
} finally {
  await s.close();
}
