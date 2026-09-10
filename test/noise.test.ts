/**
 * Mathematical properties of the noise library, checked on the real driver.
 *
 * Everything here is a property that is either true or false — a derivative
 * matches the function it differentiates, a distance is 1-Lipschitz, a curl is
 * perpendicular to the gradient it came from. These are exactly the bugs the
 * rest of the suite cannot see: the golden reference images pin what a piece
 * USED to look like, so a derivative that was already wrong when the reference
 * was made stays wrong and stays green forever.
 *
 * Each probe renders a grid of independent sample points and reports three
 * predicates per point — see `tools/probe.ts` for why predicates rather than
 * numbers. Thresholds run coarse to fine, so a failure says not only that the
 * property broke but by how much: losing only the tightest channel is a
 * precision story, losing all three is a sign error.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('noise');

const N = 64; // 4096 independent sample points per probe

/**
 * Spread sample points over a few lattice cells at an irrational-ish stride, so
 * the grid does not land on the noise lattice — the derivative of an
 * interpolant is most wrong BETWEEN lattice points, which is precisely where a
 * grid-aligned probe would never look.
 */
const POINT = `
vec2 q = (pix + 0.5) / n;
vec2 sp = vec2(q.x * 7.3137 - 3.1, q.y * 6.1803 - 2.7);
`;

const s = await launch(5211);
try {
  // --- gradient noise: analytic derivative vs central differences -----------
  //
  // Central differences carry their own error: truncation ~h^2 and roundoff
  // ~eps/h, which at h = 1e-2 in float32 bottoms out around 1e-4. So the
  // tightest threshold below is deliberately looser than that floor. It is
  // still far tighter than any of the mistakes worth catching — a dropped
  // interpolant term, a sign, a missing scale — which are all O(1).
  {
    const img = await runProbe(s, {
      includes: ['noise/deriv.glsl'],
      body: `${POINT}
vec3 nd = nzGrad21d(sp);
float h = 0.01;
vec2 fd = vec2(
    nzGrad21(sp + vec2(h, 0.0)) - nzGrad21(sp - vec2(h, 0.0)),
    nzGrad21(sp + vec2(0.0, h)) - nzGrad21(sp - vec2(0.0, h))) / (2.0 * h);
float err = length(nd.yz - fd);
ok = vec3(step(err, 0.1), step(err, 0.01), step(err, 0.003));

// The value half must be the SAME field, not merely a similar one: anyone
// mixing nzGrad21 and nzGrad21d in one shader is relying on that.
if (abs(nd.x - nzGrad21(sp)) > 1e-6) ok = vec3(0.0);
`,
    }, N);
    const c = countFailures(img);
    check('nzGrad21d matches central differences',
      c.failed[0] === 0 && c.failed[1] === 0,
      describe(c, ['<0.1', '<0.01', '<0.003']));
    check('nzGrad21d is accurate to the finite-difference floor',
      c.failed[2] === 0, describe(c, ['<0.1', '<0.01', '<0.003']));
  }

  // --- fbm: the accumulated transform, transposed --------------------------
  //
  // The mistake this exists for: octave i is evaluated at M p, so the chain
  // rule wants M TRANSPOSED on that octave's gradient. Using M instead rotates
  // the gradient field by a growing angle — a flow field whose streamlines curl
  // the wrong way while still looking exactly like streamlines.
  //
  // A CONVERGENCE STUDY, not a fixed threshold, and the difference matters.
  // The first version compared against central differences at h = 0.01 and
  // failed at four octaves — where the top octave has frequency 8, so the
  // truncation error carries an 8^3 factor. Measured across h = 0.02 down to
  // 0.0025, the error fell by exactly 4x for every halving of h: the signature
  // of the INTEGRATOR's truncation, not of a wrong derivative, which would have
  // plateaued at some constant instead.
  //
  // So the test asks the question that actually distinguishes those two. A
  // fixed threshold only ever says "close enough at one step size", and picking
  // the step size until it passes is not a test.
  for (const [label, octaves] of [['1 octave', 1], ['4 octaves', 4]] as const) {
    const img = await runProbe(s, {
      includes: ['noise/deriv.glsl'],
      body: `${POINT}
const int OCT = ${octaves};
vec3 nd = nzFbm21d(sp, OCT, 2.0, 0.5);

// h scaled to the finest octave. The top octave has frequency 2^(OCT-1), and
// truncation goes as h^2 times a third derivative carrying that frequency
// cubed — so one step size cannot serve both cases. At a fixed h = 0.008 the
// smooth 1-octave field was already at the roundoff floor at all but 6 of 4088
// sample points, and its "convergence check" was testing essentially nothing.
float h1 = 0.05 / exp2(float(OCT - 1));
vec2 fd1 = vec2(
    nzFbm21(sp + vec2(h1, 0.0), OCT, 2.0, 0.5) - nzFbm21(sp - vec2(h1, 0.0), OCT, 2.0, 0.5),
    nzFbm21(sp + vec2(0.0, h1), OCT, 2.0, 0.5) - nzFbm21(sp - vec2(0.0, h1), OCT, 2.0, 0.5))
    / (2.0 * h1);
float h2 = h1 * 0.5;
vec2 fd2 = vec2(
    nzFbm21(sp + vec2(h2, 0.0), OCT, 2.0, 0.5) - nzFbm21(sp - vec2(h2, 0.0), OCT, 2.0, 0.5),
    nzFbm21(sp + vec2(0.0, h2), OCT, 2.0, 0.5) - nzFbm21(sp - vec2(0.0, h2), OCT, 2.0, 0.5))
    / (2.0 * h2);

float e1 = length(nd.yz - fd1);
float e2 = length(nd.yz - fd2);

// The ratio only means anything while TRUNCATION dominates. Below that,
// roundoff takes over — it grows as 1/h while truncation falls as h^2 — and
// halving h stops helping. This floor is about a hundred times the roundoff
// scale (eps/h ~ 1e-5). Measured, the smooth 1-octave case fell below it far
// more often than the rough 4-octave one, which is exactly what roundoff
// predicts and the opposite of what a wrong derivative would do.
float meaningful = step(1.0e-3, e1);

// Second order: halving h must cut the error by well more than half. A
// derivative that is simply WRONG leaves a residual that does not shrink at
// all, which is the case this separates from mere imprecision.
float converges = max(step(e2 * 2.5, e1), 1.0 - meaningful);

ok = vec3(
    min(converges, step(e2, 0.02)),
    step(abs(nd.x - nzFbm21(sp, OCT, 2.0, 0.5)), 1e-4),
    meaningful);
`,
    }, N);
    const c = countFailures(img);
    const tested = c.total - c.failed[2];
    const d = `converges: ${c.total - c.failed[0]}/${c.total}  ` +
      `value agrees: ${c.total - c.failed[1]}/${c.total}  ` +
      `truncation-dominated at ${tested}/${c.total} points`;
    // The ABSOLUTE bound is the correctness statement and holds everywhere.
    // The RATIO is the "this residual is the integrator's, not the model's"
    // statement, and it is a claim about the population rather than about every
    // point: where the third derivative nearly vanishes, the leading truncation
    // term does too, e1 is anomalously small by accident, and the ratio stops
    // being informative at that one point. Hence 99% rather than 100%.
    const converged = c.total - c.failed[0];
    check(`nzFbm21d converges on central differences at second order (${label})`,
      converged >= c.total * 0.99, d);
    check(`nzFbm21d value agrees with nzFbm21 (${label})`, c.failed[1] === 0, d);
    // Without this the convergence check could be made to pass by raising the
    // floor until nothing qualifies — the same trap as a radius comparison that
    // cannot fail. It has to be exercised somewhere to mean anything.
    check(`the ${label} convergence check actually exercises something`,
      tested > c.total / 3, d);
  }

  // --- the Hessian: analytic second derivatives -----------------------------
  //
  // 013 draws the zero set of `det(I - a H)`, so an error in H does not soften
  // the picture, it MOVES the lines — by e/s where s is the slope with which
  // the determinant crosses zero, which is unbounded exactly where the cusps
  // are. Nothing downstream can notice that, because a displaced caustic is
  // still a perfectly convincing caustic.
  //
  // Checked against central differences of the ANALYTIC gradient (verified
  // above), not of the value: differencing the value twice would square the
  // roundoff and measure the difference scheme rather than the derivative.
  //
  // WHAT IS ASSERTED IS THAT THE RESIDUAL SHRINKS, not that it is small. A
  // wrong Hessian leaves a residual that does not shrink at all — measured
  // below — while a right one leaves the stencil's own truncation. The second
  // order itself is reported rather than asserted: at a point where the leading
  // truncation term nearly cancels, err1 is accidentally small and the ratio
  // stops being informative, which is a property of the sample rather than of
  // the derivative. Measured, the ratio clears 2.5 at 4023/4088 points and 1.5
  // at 4072; the two deliberately broken versions below clear 1.5 at 503 and 1.
  {
    const img = await runProbe(s, {
      includes: ['noise/hessian.glsl'],
      body: `${POINT}
mat2 h;
vec3 nd = nzGrad21dd(sp, h);

// The value and gradient must be the SAME field as noise/deriv.glsl's, or a
// shader mixing the two is silently using two different noises.
vec3 ref = nzGrad21d(sp);

float e1 = 0.02;
float e2 = 0.01;
mat2 d1 = mat2(
    (nzGrad21d(sp + vec2(e1, 0.0)).yz - nzGrad21d(sp - vec2(e1, 0.0)).yz) / (2.0 * e1),
    (nzGrad21d(sp + vec2(0.0, e1)).yz - nzGrad21d(sp - vec2(0.0, e1)).yz) / (2.0 * e1));
mat2 d2 = mat2(
    (nzGrad21d(sp + vec2(e2, 0.0)).yz - nzGrad21d(sp - vec2(e2, 0.0)).yz) / (2.0 * e2),
    (nzGrad21d(sp + vec2(0.0, e2)).yz - nzGrad21d(sp - vec2(0.0, e2)).yz) / (2.0 * e2));

float err1 = length(h[0] - d1[0]) + length(h[1] - d1[1]);
float err2 = length(h[0] - d2[0]) + length(h[1] - d2[1]);
float ratio = err1 / max(err2, 1.0e-12);

// Below this the residual is roundoff, which grows as 1/h while truncation
// falls as h^2, and halving the step stops helping.
float meaningful = step(3.0e-3, err1);
float shrinks = max(step(1.5, ratio), 1.0 - meaningful);

// The backstop is RELATIVE to the Hessian's own size. An absolute one would be
// a different test at every octave count, since |H| grows with the finest
// frequency squared — which is how the first version of the fbm case below
// failed at 139 points for having a large Hessian rather than a wrong one.
float mag = length(h[0]) + length(h[1]);

ok = vec3(
    min(shrinks, step(err2, 0.2 * mag)),
    step(length(nd - ref), 1.0e-6),
    min(meaningful, step(2.5, ratio)));
`,
    }, N);
    const c = countFailures(img);
    const secondOrder = c.total - c.failed[2];
    const d = `residual shrinks: ${c.total - c.failed[0]}/${c.total}  ` +
      `value and gradient agree with nzGrad21d: ${c.total - c.failed[1]}/${c.total}  ` +
      `and clears second order at ${secondOrder}/${c.total}`;
    check('nzGrad21dd leaves a residual that shrinks with the step size',
      c.total - c.failed[0] >= c.total * 0.99, d);
    check('nzGrad21dd returns the same value and gradient as nzGrad21d',
      c.failed[1] === 0, d);
    check('the Hessian convergence check actually exercises something',
      secondOrder > c.total / 3, d);
  }

  // --- the control for the single cell: the mixed term ----------------------
  //
  // `du.x * du.y * k2` is the term that comes only from the bilinear corner. It
  // vanishes wherever the four corner values happen to be separable, so a probe
  // on axis-aligned test data would never see it missing, and the resulting
  // Hessian is right along the lattice and wrong between it.
  //
  // Rebuilt here without that term, on the same inputs, and required to BOTH
  // disagree with the real one and fail the convergence check the real one
  // passes. Without this the check above would pass just as happily on a
  // Hessian missing a term, because the residual of a nearly-right Hessian
  // still shrinks over most of the plane.
  {
    const img = await runProbe(s, {
      includes: ['noise/hessian.glsl'],
      body: `${POINT}
mat2 h;
vec3 nd = nzGrad21dd(sp, h);

vec2 ip = floor(sp);
vec2 f  = fract(sp);
vec2 u = quintic(f), du = quinticD(f), ddu = quinticDD(f);
vec2 ga = nzGradVec(ip + vec2(0.0, 0.0));
vec2 gb = nzGradVec(ip + vec2(1.0, 0.0));
vec2 gc = nzGradVec(ip + vec2(0.0, 1.0));
vec2 gd = nzGradVec(ip + vec2(1.0, 1.0));
float va = dot(ga, f);
float vb = dot(gb, f - vec2(1.0, 0.0));
float vc = dot(gc, f - vec2(0.0, 1.0));
float vd = dot(gd, f - vec2(1.0, 1.0));
float k0 = vb - va;            vec2 dk0 = gb - ga;
float k1 = vc - va;            vec2 dk1 = gc - ga;
float k2 = va - vb - vc + vd;  vec2 dk2 = ga - gb - gc + gd;
vec2 m = vec2(k0 + u.y * k2, k1 + u.x * k2);
float bxx = 2.0 * du.x * (dk0.x + u.y * dk2.x) + ddu.x * m.x;
float byy = 2.0 * du.y * (dk1.y + u.x * dk2.y) + ddu.y * m.y;
// The one difference: du.x * du.y * k2 is dropped.
float bxy = du.x * (dk0.y + u.y * dk2.y) + du.y * (dk1.x + u.x * dk2.x);
mat2 broken = NZ_GRAD_SCALE * mat2(bxx, bxy, bxy, byy);

float e1 = 0.02;
float e2 = 0.01;
mat2 d1 = mat2(
    (nzGrad21d(sp + vec2(e1, 0.0)).yz - nzGrad21d(sp - vec2(e1, 0.0)).yz) / (2.0 * e1),
    (nzGrad21d(sp + vec2(0.0, e1)).yz - nzGrad21d(sp - vec2(0.0, e1)).yz) / (2.0 * e1));
mat2 d2 = mat2(
    (nzGrad21d(sp + vec2(e2, 0.0)).yz - nzGrad21d(sp - vec2(e2, 0.0)).yz) / (2.0 * e2),
    (nzGrad21d(sp + vec2(0.0, e2)).yz - nzGrad21d(sp - vec2(0.0, e2)).yz) / (2.0 * e2));

float gap = length(h[0] - broken[0]) + length(h[1] - broken[1]);
float b1 = length(broken[0] - d1[0]) + length(broken[1] - d1[1]);
float b2 = length(broken[0] - d2[0]) + length(broken[1] - d2[1]);
float bratio = b1 / max(b2, 1.0e-12);

ok = vec3(step(0.05, gap), 1.0 - step(1.5, bratio), step(0.05, b2));
`,
    }, N);
    const c = countFailures(img);
    const d = `differs from the real Hessian: ${c.total - c.failed[0]}/${c.total}  ` +
      `and its residual does not shrink: ${c.total - c.failed[1]}/${c.total}  ` +
      `nor is it small: ${c.total - c.failed[2]}/${c.total}`;
    // A POPULATION BAR, and the shortfall is the point rather than slack. The
    // dropped term is du.x * du.y * k2, which is itself zero wherever either
    // quintic derivative vanishes — the whole neighbourhood of every cell edge
    // — and small wherever the bilinear corner k2 is. So roughly a sixth of the
    // plane cannot tell the two apart at all, and a probe that happened to
    // sample only there would have reported a Hessian it never checked.
    check('dropping the mixed term gives a measurably different Hessian',
      c.total - c.failed[0] >= c.total * 0.8, d);
    check('and one the convergence check above rejects',
      c.total - c.failed[1] >= c.total * 0.8, d);
  }

  // --- the fbm chain rule, one order up ------------------------------------
  //
  // Octave i is evaluated at M p, so the Hessian accumulates as M^T H M. The
  // near-miss is M H M^T, and it is a near-miss in the worst way: it agrees
  // exactly at one octave (M is the identity) and diverges only as the octave
  // index grows, so it gets the large folds right and the fine ones wrong.
  //
  // THE CONTROL IS THAT WRONG VERSION, accumulated here by hand. Measured, it
  // clears the shrink test at 1 of 4088 points against the real one's 4033 —
  // which is what a model error rather than a stencil error looks like.
  {
    const img = await runProbe(s, {
      includes: ['noise/hessian.glsl'],
      body: `${POINT}
const int OCT = 3;
mat2 h;
vec3 nd = nzFbm21dd(sp, OCT, 2.0, 0.5, h);

// h scaled to the finest octave, as in the gradient case above.
float e1 = 0.05 / exp2(float(OCT - 1));
float e2 = e1 * 0.5;
mat2 g1, g2, g3, g4;
mat2 d1 = mat2(
    (nzFbm21dd(sp + vec2(e1, 0.0), OCT, 2.0, 0.5, g1).yz
   - nzFbm21dd(sp - vec2(e1, 0.0), OCT, 2.0, 0.5, g2).yz) / (2.0 * e1),
    (nzFbm21dd(sp + vec2(0.0, e1), OCT, 2.0, 0.5, g3).yz
   - nzFbm21dd(sp - vec2(0.0, e1), OCT, 2.0, 0.5, g4).yz) / (2.0 * e1));
mat2 d2 = mat2(
    (nzFbm21dd(sp + vec2(e2, 0.0), OCT, 2.0, 0.5, g1).yz
   - nzFbm21dd(sp - vec2(e2, 0.0), OCT, 2.0, 0.5, g2).yz) / (2.0 * e2),
    (nzFbm21dd(sp + vec2(0.0, e2), OCT, 2.0, 0.5, g3).yz
   - nzFbm21dd(sp - vec2(0.0, e2), OCT, 2.0, 0.5, g4).yz) / (2.0 * e2));

float err1 = length(h[0] - d1[0]) + length(h[1] - d1[1]);
float err2 = length(h[0] - d2[0]) + length(h[1] - d2[1]);
float ratio = err1 / max(err2, 1.0e-12);
float meaningful = step(3.0e-3, err1);
float shrinks = max(step(1.5, ratio), 1.0 - meaningful);
float mag = length(h[0]) + length(h[1]);

// The control: the same accumulation with the transform on the wrong side.
mat2 rot = rot2(NZ_FBM_ROT);
mat2 mm = mat2(1.0);
mat2 wrong = mat2(0.0);
float amp = 1.0;
float norm = 0.0;
for (int i = 0; i < OCT; ++i) {
    mat2 hi;
    vec3 unused = nzGrad21dd(mm * sp, hi);
    wrong += amp * (mm * hi * transpose(mm));
    norm += amp;
    mm = 2.0 * rot * mm;
    amp *= 0.5;
}
wrong = wrong / max(norm, EPS);
float w1 = length(wrong[0] - d1[0]) + length(wrong[1] - d1[1]);
float w2 = length(wrong[0] - d2[0]) + length(wrong[1] - d2[1]);
float wratio = w1 / max(w2, 1.0e-12);

ok = vec3(
    min(shrinks, step(err2, 0.2 * mag)),
    1.0 - step(1.5, wratio),
    min(meaningful, step(2.5, ratio)));
`,
    }, N);
    const c = countFailures(img);
    const secondOrder = c.total - c.failed[2];
    const rejected = c.total - c.failed[1];
    const d = `residual shrinks: ${c.total - c.failed[0]}/${c.total}  ` +
      `M H M^T's does not: ${rejected}/${c.total}  ` +
      `and clears second order at ${secondOrder}/${c.total}`;
    check('nzFbm21dd leaves a residual that shrinks with the step size',
      c.total - c.failed[0] >= c.total * 0.98, d);
    check('putting the transform on the wrong side fails that same check',
      rejected >= c.total * 0.98, d);
    check('the fbm Hessian convergence check actually exercises something',
      secondOrder > c.total / 3, d);
  }

  // --- why the interpolant is a quintic ------------------------------------
  //
  // Both the cubic smoothstep and the quintic have zero FIRST derivative at 0
  // and 1, so both give a C1 field and the gradient is continuous either way.
  // Only the quintic has zero SECOND derivative there. On the cubic the Hessian
  // would jump by 6 times the local blend at every cell edge, and a picture
  // driven by curvature would show the noise lattice as a grid of creases —
  // which reads as "this noise is grid-aligned", not as "the interpolant is
  // one order short".
  //
  // Measured as a CONVERGENCE, not a threshold: straddle a lattice line at
  // distance e and at e/2. A continuous Hessian's jump halves; a discontinuous
  // one plateaus at the size of the discontinuity. A fixed tolerance could not
  // tell those apart at any single e.
  {
    const img = await runProbe(s, {
      includes: ['noise/hessian.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
// Ride along the lattice line x = 3, at 4088 different heights.
float y = q.x * 5.7 + q.y * 0.0139 - 2.3;
float e1 = 0.004;
float e2 = e1 * 0.5;

mat2 a1, b1, a2, b2;
vec3 u1 = nzGrad21dd(vec2(3.0 - e1, y), a1);
vec3 u2 = nzGrad21dd(vec2(3.0 + e1, y), b1);
vec3 u3 = nzGrad21dd(vec2(3.0 - e2, y), a2);
vec3 u4 = nzGrad21dd(vec2(3.0 + e2, y), b2);

float jump1 = length(a1[0] - b1[0]) + length(a1[1] - b1[1]);
float jump2 = length(a2[0] - b2[0]) + length(a2[1] - b2[1]);

// The two endpoint values that make it work, stated exactly. The cubic
// smoothstep's second derivative is 6 - 12t, which is -6 and +6 here.
float ends = abs(quinticDD(vec2(0.0)).x) + abs(quinticDD(vec2(1.0)).x);

float meaningful = step(1.0e-4, jump1);
float halves = max(step(jump2 * 1.7, jump1), 1.0 - meaningful);

ok = vec3(halves, step(ends, 1.0e-6), meaningful);
`,
    }, N);
    const c = countFailures(img);
    const tested = c.total - c.failed[2];
    const d = `jump halves with the offset: ${c.total - c.failed[0]}/${c.total}  ` +
      `quinticDD vanishes at both ends: ${c.total - c.failed[1]}/${c.total}  ` +
      `jump above the roundoff floor at ${tested}/${c.total}`;
    check('the Hessian is continuous across a lattice line',
      c.total - c.failed[0] >= c.total * 0.99, d);
    check("quinticDD is zero at 0 and 1, which is what makes that true",
      c.failed[1] === 0, d);
    note(`straddling the lattice line at 0.004 the Hessian differs by more than ` +
      `the roundoff floor at ${tested}/${c.total} points, so the halving above is ` +
      `measuring something; the cubic interpolant would leave a jump of 6 times ` +
      `the local blend that no offset makes smaller`);
  }

  // --- curl: the two identities that make it divergence-free ---------------
  //
  // v = (psi_y, -psi_x) is perpendicular to grad(psi) and exactly as long.
  // Both are algebraic, so they hold to machine precision when the derivative
  // is right and fail outright when it is not — a much sharper instrument than
  // measuring divergence, which would mostly measure the finite differences
  // used to measure it.
  {
    const img = await runProbe(s, {
      includes: ['noise/curl.glsl'],
      body: `${POINT}
vec3 nd = nzFbm21d(sp, 3, 2.0, 0.5);
vec2 v = nzCurl21(sp, 3, 2.0, 0.5);
float mag = max(length(nd.yz), 1e-6);
float perp = abs(dot(v, nd.yz)) / (mag * mag);
float lenErr = abs(length(v) - length(nd.yz)) / mag;
// Sign matters: (psi_y, -psi_x), not (-psi_y, psi_x). Both are perpendicular
// and equal in length, so the two checks above cannot tell them apart — the
// cross product can.
//
// For v = (g.y, -g.x) the z-component of cross(v, g) works out to g.y^2 + g.x^2,
// so it is |g|^2 exactly. Normalising by |g|^2 therefore pins the sign AND the
// magnitude relation in one number that must be +1. The first version of this
// line asserted the cross product was NEGATIVE, which is false everywhere — it
// failed at all 4096 points and was reported as passing, because the probe
// harness was serving a stale result at the time.
float crossz = v.x * nd.z - v.y * nd.y;
float handed = abs(crossz / max(dot(nd.yz, nd.yz), 1e-12) - 1.0);
ok = vec3(step(perp, 1e-5), step(lenErr, 1e-5), step(handed, 1e-4));
`,
    }, N);
    const c = countFailures(img);
    check('nzCurl21 is perpendicular to the potential gradient', c.failed[0] === 0,
      describe(c, ['perpendicular', 'same length', 'right-handed']));
    check('nzCurl21 preserves the gradient magnitude', c.failed[1] === 0,
      describe(c, ['perpendicular', 'same length', 'right-handed']));
    check('nzCurl21 rotates the gradient the right way, by exactly a quarter turn',
      c.failed[2] === 0, describe(c, ['perpendicular', 'same length', 'handedness']));
  }

  // --- worley: is the radius argument honoured at all? ---------------------
  //
  // THE CONTROL, and it comes first because without it every radius comparison
  // below is vacuous: if the loop bound were ignored, radius 1 and radius 3
  // would agree perfectly and the suite would report a guarantee it never
  // tested. Radius 0 sees only the centre cell and must disagree constantly.
  {
    const img = await runProbe(s, {
      includes: ['noise/worley.glsl'],
      body: `${POINT}
int seed = int(pix.y) * int(n) + int(pix.x);
NzWorleyF w3 = nzWorley21fr(sp, 1.0, seed, 3);
NzWorleyF w0 = nzWorley21fr(sp, 1.0, seed, 0);
ok = vec3(step(1e-6, abs(w0.f1 - w3.f1)), 1.0, 1.0);
`,
    }, N);
    const c = countFailures(img);
    const differing = c.total - c.failed[0];
    check('a narrower worley search really does give different answers',
      differing > c.total / 4,
      `radius 0 differs from radius 3 at ${differing}/${c.total} points — ` +
        'the radius comparisons below are only meaningful because of this');
  }

  // --- worley: the search radius, by brute force ---------------------------
  //
  // The derivation in worley.glsl says 3x3 stops being sufficient above
  // jitter ~0.657. Rather than trust it, ask the same query at radius 1, 2 and
  // 3 and see where the answers stop changing. Radius 3 is the reference.
  for (const jitter of [0.6, 1.0]) {
    const img = await runProbe(s, {
      includes: ['noise/worley.glsl'],
      body: `${POINT}
const float J = ${jitter.toFixed(2)};
NzWorleyF wide = nzWorley21fr(sp, J, 7, 3);
NzWorleyF got  = nzWorley21f(sp, J, 7);
NzWorleyF r1   = nzWorley21fr(sp, J, 7, 1);
ok = vec3(
    step(abs(got.f1 - wide.f1) + abs(got.f2 - wide.f2), 1e-6),
    step(abs(r1.f1 - wide.f1), 1e-6),
    step(got.f1, got.f2));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['chosen radius exact', '3x3 would be exact', 'F1 <= F2']);
    check(`worley at jitter ${jitter} finds the true nearest points`, c.failed[0] === 0, d);
    check(`worley F1 never exceeds F2 at jitter ${jitter}`, c.failed[2] === 0, d);
    // Not a failure either way — this reports whether the wider search was
    // actually needed, which is the claim the derivation makes.
    // Reported, never asserted. Outside the proven bound 3x3 CAN be wrong, and
    // measurement says it essentially never is (0 in 262144 at jitter 1,
    // adversarial geometry included). The wider search buys a guarantee rather
    // than fixing observed failures — worth saying plainly, because a number
    // that always reads zero invites someone to delete what produced it.
    note(jitter <= 0.6568542
      ? `  jitter ${jitter}: inside the proven 3x3 bound; 3x3 disagreed at ${c.failed[1]} points`
      : `  jitter ${jitter}: outside the proven 3x3 bound; 3x3 disagreed at ${c.failed[1]}` +
        ` of ${c.total} — rare in practice, which is why this is a note and not a check`);
  }

  // --- worley F1 is a distance ---------------------------------------------
  //
  // 1-Lipschitz is what lets F1 be antialiased like a signed distance. It is
  // also the first property a too-small search destroys, so this is the check
  // that would catch a future "optimisation" back down to 3x3.
  {
    const img = await runProbe(s, {
      includes: ['noise/worley.glsl'],
      body: `${POINT}
float d = 0.037;
vec2 dir = normalize(vec2(0.7071, 0.7071));
float a = nzWorley21(sp, 1.0, 7);
float b = nzWorley21(sp + dir * d, 1.0, 7);
float slope = abs(b - a) / d;
ok = vec3(step(slope, 1.0 + 1e-4), step(a, 1.4143), step(-a, 0.0));
`,
    }, N);
    const c = countFailures(img);
    check('worley F1 is 1-Lipschitz', c.failed[0] === 0,
      describe(c, ['slope <= 1', 'F1 <= sqrt(2)', 'F1 >= 0']));
    check('worley F1 stays within its geometric bounds',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['slope <= 1', 'F1 <= sqrt(2)', 'F1 >= 0']));
  }

  check('no console errors while probing', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));
} finally {
  await s.close();
}
