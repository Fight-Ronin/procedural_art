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
