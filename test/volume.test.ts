/**
 * Is the volume integrator actually the integral?
 *
 * A marching loop that accumulates emission produces a plausible glow whichever
 * way it is written, and the two common ways differ by something invisible on
 * any single image: whether the answer depends on the step count. The
 * first-order form, `L += T * sigma * h * Le`, converges to the same place as
 * the step shrinks, so a picture rendered with it looks fine — and then quietly
 * changes brightness when the marcher's budget changes, which for this repo
 * means the preview and the print are different pictures for a reason nobody
 * can see in either one.
 *
 * So the property under test is not convergence. It is EXACTNESS AT ANY STEP
 * SIZE, against the closed form for a uniform slab, which the module states
 * itself in `volSlab`. Marching a constant medium in N steps must land on the
 * analytic answer for every N, not merely for large N.
 *
 * The control is the first-order form. It must fail at coarse steps and pass at
 * fine ones — a control that failed everywhere would leave open the suspicion
 * that the comparison is broken rather than the formula.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('volume');

const N = 64; // 4096 (sigma, emission) pairs per probe

/**
 * Extinction over three decades and a length either side of 1, so the tests
 * cover optically thin (transmittance near 1, where almost anything works) and
 * optically thick (where the two forms diverge hardest).
 */
const SETUP = `
vec2 q = (pix + 0.5) / n;
float sigma = exp2(mix(-4.0, 4.0, q.x));
float len   = mix(0.35, 2.6, q.y);
vec3 Le = vec3(0.8, 0.55, 0.3);
`;

const s = await launch(5223);
try {
  // --- exact at any step count ----------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['volume/emission.glsl'],
      body: `${SETUP}
float Tref;
vec3 Lref = volSlab(Le, sigma, len, Tref);

// March the same slab three ways. The step counts are deliberately absurd at
// the low end: 2 steps through an optically thick medium is where a
// first-order integrator is not merely imprecise but wrong.
vec3 worst = vec3(0.0);
float tWorst = 0.0;
for (int k = 0; k < 3; ++k) {
    int steps = k == 0 ? 2 : (k == 1 ? 7 : 64);
    float h = len / float(steps);
    vec3 L = vec3(0.0);
    float T = 1.0;
    for (int i = 0; i < 64; ++i) {
        if (i >= steps) break;
        volStep(L, T, Le, sigma, h);
    }
    worst = max(worst, abs(L - Lref));
    tWorst = max(tWorst, abs(T - Tref));
}

// float32 through a chain of exp() and a running product, nothing else: the
// answer is algebraically identical at every step count.
float e = max(max(worst.r, worst.g), worst.b);
ok = vec3(step(e, 1.0e-5), step(tWorst, 1.0e-5), step(abs(Tref - volTransmit(sigma, len)), 1.0e-6));
`,
    }, N);
    const c = countFailures(img);
    check('volStep matches the closed form at 2, 7 and 64 steps alike',
      c.failed[0] === 0, describe(c, ['radiance', 'transmittance', 'volSlab agrees with volTransmit']));
    check('transmittance is exact and volSlab agrees with volTransmit',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['radiance', 'transmittance', 'volSlab agrees with volTransmit']));
  }

  // --- the control -----------------------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['volume/emission.glsl'],
      decls: `
// The first-order form everyone writes first, as a function so the probe can
// call it at two step counts. It lives in decls because GLSL allows no
// declarations inside a function body, which is where a probe's body lands.
vec3 marchLinear(vec3 Le, float sigma, float len, int steps) {
    float h = len / float(steps);
    vec3 L = vec3(0.0);
    float T = 1.0;
    for (int i = 0; i < 512; ++i) {
        if (i >= steps) break;
        L += T * sigma * h * Le;
        T *= 1.0 - sigma * h;
        T = max(T, 0.0);       // it can go negative, which is its own tell
    }
    return L;
}
`,
      body: `${SETUP}
float Tref;
vec3 Lref = volSlab(Le, sigma, len, Tref);

vec3 coarse = marchLinear(Le, sigma, len, 4);
vec3 fine = marchLinear(Le, sigma, len, 512);

float eCoarse = length(coarse - Lref);
float eFine = length(fine - Lref);
// A slab thin enough to be nearly transparent is forgiving of any formula, so
// the claim is only made where there is something to get wrong. 0.2 optical
// depths is mild — the point is not that the control fails spectacularly but
// that it is NOT EXACT, measured against the same 1e-5 volStep meets
// everywhere. An absolute threshold picked by eye would be a number chosen to
// make the control pass, which is the opposite of a control.
float real = step(0.2, sigma * len);

ok = vec3(
    max(step(1.0e-3, eCoarse), 1.0 - real),
    // and converges when hammered, so the comparison itself is sound
    step(eFine, 0.02),
    // the coarse error shrinks with the step count: it is truncation, not noise
    max(step(eFine * 2.0 + 1.0e-4, eCoarse), 1.0 - real));
`,
    }, N);
    const c = countFailures(img);
    check('the first-order form FAILS at coarse steps in a thick medium (control)',
      c.failed[0] === 0, describe(c, ['coarse is wrong', 'fine converges', 'wrong side']));
    check('the first-order form converges when the steps are fine (control)',
      c.failed[1] === 0, describe(c, ['coarse is wrong', 'fine converges', 'wrong side']));
  }

  // --- the sphere span used to bound the march -------------------------------
  {
    const img = await runProbe(s, {
      includes: ['volume/emission.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
// Rays from a ring of origins towards jittered targets, so both hits and
// misses occur and neither is a special case of the other.
float a = q.x * 6.2831853;
vec3 ro = vec3(cos(a), sin(a) * 0.6, sin(a)) * 3.0;
vec3 target = vec3(q.y * 2.4 - 1.2, cos(a * 3.1) * 0.9, sin(a * 2.3) * 0.9);
vec3 rd = normalize(target - ro);
vec3 centre = vec3(0.15, -0.1, 0.05);
float R = 0.8;

vec2 span = volSphereSpan(ro, rd, centre, R);
bool hit = span.y >= span.x;

// Independent membership: brute-force the closest approach.
float best = 1.0e9;
for (int i = 0; i <= 400; ++i) {
    float t = mix(-1.0, 7.0, float(i) / 400.0);
    best = min(best, length(ro + rd * t - centre));
}
bool near = best < R - 0.02;
bool far_ = best > R + 0.02;

float agree = 1.0;
if (near) agree = hit ? 1.0 : 0.0;
if (far_) agree = hit ? 0.0 : 1.0;

// On a hit the endpoints must sit ON the sphere, and near must precede far.
float onSphere = 1.0;
if (hit && near) {
    float e0 = abs(length(ro + rd * span.x - centre) - R);
    float e1 = abs(length(ro + rd * span.y - centre) - R);
    onSphere = step(max(e0, e1), 2.0e-5);
}
ok = vec3(agree, onSphere, hit ? step(span.x, span.y) : 1.0);
`,
    }, N);
    const c = countFailures(img);
    check('volSphereSpan agrees with a brute-force closest approach',
      c.failed[0] === 0, describe(c, ['hit/miss', 'endpoints on the sphere', 'ordered']));
    check('volSphereSpan returns entry and exit, in order, on the surface',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['hit/miss', 'endpoints on the sphere', 'ordered']));
  }

  // --- the phase function integrates to one ---------------------------------
  {
    const img = await runProbe(s, {
      includes: ['volume/emission.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
float g = mix(-0.9, 0.9, q.x);

// Integrate over the sphere in cos-theta, which is the measure that makes the
// solid angle uniform: INTEGRAL p dOmega = 2 pi INTEGRAL p dmu.
const int M = 2048;
float sum = 0.0;
for (int i = 0; i < M; ++i) {
    float mu = -1.0 + 2.0 * (float(i) + 0.5) / float(M);
    sum += volPhaseHg(mu, g);
}
float integral = sum * (2.0 / float(M)) * 6.2831853;

// Forward scattering must actually be forward.
float fwd = volPhaseHg(1.0, g), back = volPhaseHg(-1.0, g);
float oriented = g > 0.05 ? step(back, fwd) : (g < -0.05 ? step(fwd, back) : 1.0);

ok = vec3(step(abs(integral - 1.0), 2.0e-3), step(0.0, volPhaseHg(mix(-1.0, 1.0, q.y), g)), oriented);
`,
    }, N);
    const c = countFailures(img);
    check('volPhaseHg integrates to 1 over the sphere',
      c.failed[0] === 0, describe(c, ['normalised', 'non-negative', 'oriented by g']));
    check('volPhaseHg is non-negative and points the way g says',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['normalised', 'non-negative', 'oriented by g']));
  }
} finally {
  await s.close();
}
