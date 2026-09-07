/**
 * Resolution stability of the antialiasing primitives.
 *
 * The property under test is not "does the edge look smooth" — every
 * formulation looks smooth, including the wrong one this directory replaced.
 * It is that the AMOUNT OF INK IS THE SAME AT EVERY OUTPUT RESOLUTION, which
 * is what the eye cannot check and what a print exposes immediately.
 *
 * So each probe integrates the coverage function numerically over a domain
 * that is fixed in DOMAIN units, at several pixel footprints, and asks whether
 * the answers agree with each other and with the exact geometric area. A
 * quadrature inside a shader is unusual for a test, but it is the only way to
 * ask the question directly: the alternative — render a piece at two sizes and
 * compare means — is what `test/render.test.ts` already does, and it can only
 * say that something drifted, never which primitive drifted.
 *
 * The last channel of the band probe is a CONTROL running the old, biased
 * formulation. It must FAIL. A stability test that would also pass on the
 * broken code is not a test.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('aa');

const N = 64; // 4096 independent (h, w) pairs per probe

const s = await launch(5215);
try {
  // --- aaStep: an unbiased half-space coverage ------------------------------
  //
  // The defining property is antisymmetry: the coverage of `x < 0` and of
  // `x > 0` must sum to exactly one pixel. Anything that filters from the
  // threshold outward — `smoothstep(0, w, x)`, the shape almost everyone
  // reaches for — breaks this, and breaks it in the direction that grows the
  // shape by half a footprint. That half-footprint is the entire bug.
  {
    const img = await runProbe(s, {
      includes: ['aa/edge.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
float w = exp2(mix(-8.0, 1.0, q.y));       // footprints over three decades
float x = (q.x * 2.0 - 1.0) * 2.0 * w;     // sample across the transition

float sum = aaStep(x, w) + aaStep(-x, w);
float monotone = step(aaStep(x + 0.25 * w, w), aaStep(x, w) + 1e-6);
// Outside the filter footprint the answer must be the hard step exactly:
// a transition that is still soft a pixel away is a wider shape than asked
// for, which is the same failure as the bias above wearing a different hat.
float outside = 1.0;
if (x <= -0.5 * w) outside = step(1.0 - 1e-6, aaStep(x, w));
if (x >=  0.5 * w) outside = step(aaStep(x, w), 1e-6);

ok = vec3(step(abs(sum - 1.0), 1e-5), monotone, outside);
`,
    }, N);
    const c = countFailures(img);
    check('aaStep is unbiased: coverage of x<0 and x>0 sum to one pixel',
      c.failed[0] === 0, describe(c, ['antisymmetric', 'monotone', 'exact outside']));
    check('aaStep is monotone and exact beyond the footprint',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['antisymmetric', 'monotone', 'exact outside']));
  }

  // --- aaBand: the integral is the geometric area, at every footprint --------
  //
  // NOT redundant with the probe above, in either direction. Measured: adding a
  // constant 0.25 bias to aaStep fails every check up there and passes every
  // check down here, because a shift common to both half-spaces cancels in the
  // difference — the band moves, its area does not. So the two probes catch
  // disjoint mistakes and both are load-bearing.
  //
  // Quadrature over [-T, T] at a spacing fine enough to resolve the smaller of
  // h and w. The exact answer is 2h — no w in it anywhere, which is precisely
  // the claim. Two footprints eight times apart stand in for the 300px/900px
  // comparison that started this.
  // The midpoint rule is EXACT for a piecewise-linear integrand as long as no
  // kink falls inside a cell — and aaBand is piecewise linear, with kinks only
  // at +/-(h +/- w/2). So h and w are snapped to the quadrature lattice (w to an
  // even multiple, since w/2 must land on it too), every kink lands on a cell
  // boundary, and the only error left is float32 accumulation over 1024 terms.
  //
  // That is worth the six lines: without it the quadrature error is ~1% at the
  // small-w corner, which would force a tolerance loose enough to hide the very
  // drift the test is looking for.
  const BAND = `
vec2 q = (pix + 0.5) / n;
const int M = 1024;
float T = 1.0;
float dx = 2.0 * T / float(M);            // T is an exact multiple of dx

float h = max(round(exp2(mix(-6.0, -3.0, q.x)) / dx), 1.0) * dx;
float w = max(round(exp2(mix(-6.0, -3.0, q.y)) / (2.0 * dx)), 1.0) * 2.0 * dx;
// Widest support in play is h + (8w)/2 = 0.125 + 0.5, comfortably inside T,
// so nothing is truncated at the ends of the domain.

float area1 = 0.0, area8 = 0.0, ctrl1 = 0.0, ctrl8 = 0.0;
for (int i = 0; i < M; ++i) {
    float x = -T + (float(i) + 0.5) * dx;
    area1 += aaBand(x, h, w) * dx;
    area8 += aaBand(x, h, w * 8.0) * dx;
    // The formulation this directory exists to replace, verbatim in shape:
    // smoothstep running from the threshold outward.
    ctrl1 += (1.0 - smoothstep(0.0, w * 1.1, abs(x) - h)) * dx;
    ctrl8 += (1.0 - smoothstep(0.0, w * 8.0 * 1.1, abs(x) - h)) * dx;
}
float exact = 2.0 * h;
// Float32 accumulation only: 1024 adds into a running sum of at most 0.25.
float tol = 3.0e-5;
`;
  {
    const img = await runProbe(s, {
      includes: ['aa/edge.glsl'],
      body: `${BAND}
ok = vec3(
    step(abs(area1 - exact), tol),
    step(abs(area8 - exact), tol),
    // The control must MISS by much more than the tolerance, or this whole
    // probe is measuring nothing.
    step(tol * 8.0, abs(ctrl8 - exact)));
`,
    }, N);
    const c = countFailures(img);
    check('aaBand ink equals the geometric area at a fine footprint',
      c.failed[0] === 0, describe(c, ['exact at w', 'exact at 8w', 'control is biased']));
    check('aaBand ink is unchanged when the footprint grows 8x',
      c.failed[1] === 0, describe(c, ['exact at w', 'exact at 8w', 'control is biased']));
    check('the old smoothstep formulation FAILS this test (control)',
      c.failed[2] === 0, describe(c, ['exact at w', 'exact at 8w', 'control is biased']));
  }

  // The number the render suite reported for 001, reproduced at the level of
  // the primitive: how far the ink moves between two footprints three times
  // apart. It is the ratio that matters, so express it as one.
  {
    const img = await runProbe(s, {
      includes: ['aa/edge.glsl'],
      body: `${BAND}
float drift = abs(area8 - area1) / exact;
float ctrlDrift = abs(ctrl8 - ctrl1) / exact;
ok = vec3(
    step(drift, 1.0e-3),
    step(drift, 1.0e-5),
    // Sensitivity: on the old shape the same comparison must move a lot.
    step(0.1, ctrlDrift));
`,
    }, N);
    const c = countFailures(img);
    check('aaBand ink drifts by under 0.1% across an 8x resolution change',
      c.failed[0] === 0, describe(c, ['<1e-3', '<1e-5', 'control drifts >10%']));
    check('the old shape drifts by more than 10% across the same change (control)',
      c.failed[2] === 0, describe(c, ['<1e-3', '<1e-5', 'control drifts >10%']));
  }

  // --- aaRepeat and aaFootprint --------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['aa/edge.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
float v = (q.x * 2.0 - 1.0) * 9.7 + q.y * 3.3;

float d = aaRepeat(v);
float direct = abs(v - floor(v + 0.5));    // distance to nearest integer
float periodic = abs(aaRepeat(v + 7.0) - d);

// aaFootprint against a field whose pixel derivatives are known exactly:
// the probe floors fragCoord, so d(pix)/d(screen) is 1 and 0 within a quad.
float a = 3.0, b = -4.0;
float lin = a * pix.x + b * pix.y;
float fp = aaFootprint(lin);

ok = vec3(
    step(abs(d - direct), 1e-6),
    step(periodic, 1e-6),
    step(abs(fp - 5.0), 1e-3));   // length(vec2(3,-4)) — NOT fwidth's 7
`,
    }, N);
    const c = countFailures(img);
    check('aaRepeat is the distance to the nearest integer, and is periodic',
      c.failed[0] === 0 && c.failed[1] === 0,
      describe(c, ['= |v - round(v)|', 'periodic', 'footprint is Euclidean']));
    check('aaFootprint measures along the gradient, not fwidth\'s Manhattan sum',
      c.failed[2] === 0, describe(c, ['= |v - round(v)|', 'periodic', 'footprint is Euclidean']));
  }
} finally {
  await s.close();
}
