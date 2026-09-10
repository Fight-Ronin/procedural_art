/**
 * Jones' turn rule, and the two branches everyone deletes.
 *
 * `agTurn` is nine lines of `if`. It is exactly the kind of function that gets
 * "simplified" into `steer toward the largest reading` by someone who reads it
 * quickly — that version is one line, it runs, it produces plausible wandering
 * agents, and it does not make networks. The difference is entirely in two
 * cases that look like they could not matter:
 *
 *   CENTRE WEAKEST -> turn at RANDOM, not toward the stronger side. The agent
 *   is straddling a ridge with trail on both sides. Which side is nominally
 *   stronger is a coin flip decided by noise it cannot resolve, so resolving it
 *   deterministically makes every agent in that situation agree — and correlated
 *   agents produce concentric rings instead of a branching network.
 *
 *   EXACTLY EQUAL -> straight, not a coin flip. Equality is the common case at
 *   the start, when the field is uniform; a coin flip there is a random walk
 *   that never commits, and nucleation takes far longer out of it.
 *
 * So the control is the naive rule, and the property under test is that the two
 * disagree exactly where they should and nowhere else. A test that only checked
 * "turns toward the stronger side" would pass on the broken version.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('agents');

const N = 64; // 4096 sensor triples per probe

/**
 * Readings drawn from a small set of levels, so exact ties happen often. A
 * continuous sweep would make ties measure-zero and the tie branch would go
 * untested — which is the branch most likely to be wrong.
 */
const SETUP = `
vec2 q = (pix + 0.5) / n;
vec3 lcr = floor(vec3(
    hash21(pix * 0.7 + 3.1),
    hash21(pix * 1.3 + 11.7),
    hash21(pix * 2.9 + 27.3)) * 4.0) / 3.0;
float rnd = hash21(pix + 101.0);
`;

const s = await launch(5235);
try {
  // --- the rule, case by case ------------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['hash/hash.glsl', 'agent/step.glsl'],
      body: `${SETUP}
float t = agTurn(lcr, rnd);
float l = lcr.x, c = lcr.y, r = lcr.z;

// Only ever -1, 0 or +1. A turn rule that returned a magnitude would make the
// caller's turn-strength parameter mean something different per branch.
float trinary = (t == -1.0 || t == 0.0 || t == 1.0) ? 1.0 : 0.0;

// The four cases, as a single predicate that must hold for every triple.
float correct = 1.0;
if (c > l && c > r)        correct = t == 0.0 ? 1.0 : 0.0;   // on a trail
else if (c < l && c < r)   correct = (t == 1.0 || t == -1.0) ? 1.0 : 0.0;  // ridge
else if (r > l)            correct = t == -1.0 ? 1.0 : 0.0;  // right is better
else if (l > r)            correct = t == 1.0 ? 1.0 : 0.0;   // left is better
else                       correct = t == 0.0 ? 1.0 : 0.0;   // dead tie

// The random branch must actually use the random number: same readings, two
// different rolls, and it must be able to give two different answers.
float usesRnd = 1.0;
if (c < l && c < r) {
    usesRnd = (agTurn(lcr, 0.2) != agTurn(lcr, 0.8)) ? 1.0 : 0.0;
}

ok = vec3(trinary, correct, usesRnd);
`,
    }, N);
    const c = countFailures(img);
    check('agTurn returns only left, right or straight',
      c.failed[0] === 0, describe(c, ['trinary', 'follows the rule', 'random branch uses rnd']));
    check('agTurn follows Jones\' rule in every case',
      c.failed[1] === 0, describe(c, ['trinary', 'follows the rule', 'random branch uses rnd']));
    check('the ridge case is decided by the random number, not by the readings',
      c.failed[2] === 0, describe(c, ['trinary', 'follows the rule', 'random branch uses rnd']));
  }

  // --- the control -----------------------------------------------------------
  //
  // THE FIRST VERSION OF THIS BLOCK WAS WRONG, and the probe said so. It claimed
  // the two rules agree except on a ridge and on an exact tie, which sounds
  // right and is not: `l=0, c=1, r=1` is neither, and they disagree there. The
  // centre TIES the best side, so the naive rule sees "centre is at least as
  // good as everything" and goes straight, while Jones asks the separate
  // question of whether one side beats the other and turns toward it. Tied is
  // not the same as best, and following the edge of a trail rather than sitting
  // on it is a large part of why the networks branch.
  //
  // So the control is stated as a MEASUREMENT rather than a partition: how often
  // do the two disagree, and does the disagreement include the specific case
  // above. Guessing at a clean case split was how the mistake got in.
  {
    const img = await runProbe(s, {
      includes: ['hash/hash.glsl', 'agent/step.glsl'],
      decls: `
// The one-liner. Steer toward whichever sensor read highest; straight if the
// centre is at least as good as both. It lives in decls because GLSL allows no
// declarations inside a function body, which is where a probe's body lands.
float turnNaive(vec3 lcr) {
    if (lcr.y >= lcr.x && lcr.y >= lcr.z) return 0.0;
    return lcr.x > lcr.z ? 1.0 : -1.0;
}
`,
      body: `${SETUP}
float l = lcr.x, c = lcr.y, r = lcr.z;
bool ridge = c < l && c < r;

// Channel 0 is inverted on purpose: it reports AGREEMENT, so the failure count
// is the disagreement count and the check below reads it as a rate. Replacing
// agTurn with the naive rule would drive that rate to zero, which is exactly
// the regression this control exists to catch.
float agrees = agTurn(lcr, rnd) == turnNaive(lcr) ? 1.0 : 0.0;

// On a ridge the naive rule is a function of the readings alone and agTurn is
// not. Checked by rolling twice rather than by comparing the two rules, because
// on any single roll they may happen to coincide.
float ridgeStochastic = ridge
    ? ((agTurn(lcr, 0.2) != agTurn(lcr, 0.8)) && (turnNaive(lcr) == turnNaive(lcr)) ? 1.0 : 0.0)
    : 1.0;

// The case the first version of this test missed, enumerated rather than
// sampled: centre tied with the better side, one side strictly better than the
// other. Jones turns, the naive rule sits still.
vec3 tied = vec3(0.0, 1.0, 1.0);
float tieCase = (agTurn(tied, rnd) == -1.0 && turnNaive(tied) == 0.0) ? 1.0 : 0.0;

ok = vec3(agrees, ridgeStochastic, tieCase);
`,
    }, N);
    const c = countFailures(img);
    const disagreed = c.failed[0];
    const rate = disagreed / 4088;
    check('the naive rule is a genuinely different function (control)',
      rate > 0.10 && rate < 0.90,
      `disagrees on ${disagreed}/4088 sensor triples (${(rate * 100).toFixed(1)}%) — ` +
        'swapping agTurn for the naive rule would make this 0');
    check('and it is deterministic on a ridge where Jones is not (control)',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['agreement rate', 'ridge is stochastic', 'centre tied with the best side']));
  }

  // --- sensor geometry and the wrap ------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['hash/hash.glsl', 'agent/step.glsl', 'core/const.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec2 p = (q * 2.0 - 1.0) * 40.0;
float heading = q.x * TAU * 3.0;
float angle = mix(0.05, 1.5, q.y);
float dist = mix(1.0, 30.0, fract(q.x * 5.0));

vec2 sl, sc, sr;
agSensors(p, heading, angle, dist, sl, sc, sr);

// All three sit exactly dist away — the centre included. A centre sensor at
// the agent's own position reads its own last deposit, so every agent believes
// it is on a trail and goes straight forever.
float radii = step(max(max(abs(length(sl - p) - dist), abs(length(sc - p) - dist)),
                       abs(length(sr - p) - dist)), 2.0e-4 * dist + 1.0e-5);

// And at exactly +/- angle from the heading, measured by the cross product so
// the SIGN is checked too: swapping left and right is a silent mirror of the
// whole simulation, and a mirrored slime mould looks entirely normal.
vec2 dir = agDir(heading);
float crossL = dir.x * (sl - p).y - dir.y * (sl - p).x;
float crossR = dir.x * (sr - p).y - dir.y * (sr - p).x;
float handed = (crossL > 0.0 && crossR < 0.0) ? 1.0 : 0.0;
float angles = step(abs(abs(crossL) - dist * sin(angle)), 1.0e-3 * dist) *
               step(abs(abs(crossR) - dist * sin(angle)), 1.0e-3 * dist);

ok = vec3(radii, handed, angles);
`,
    }, N);
    const c = countFailures(img);
    check('all three sensors sit at the declared distance, centre included',
      c.failed[0] === 0, describe(c, ['distance', 'left is left of right', 'angle']));
    check('the sensors are at +/- the declared angle, and left really is left',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['distance', 'left is left of right', 'angle']));
  }

  {
    const img = await runProbe(s, {
      includes: ['hash/hash.glsl', 'agent/step.glsl', 'core/const.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec2 size = vec2(640.0, 384.0);
// Deliberately far outside, and negative: mod() on a negative operand is the
// classic place a hand-rolled wrap goes wrong, and an agent that leaves the
// field and never comes back is invisible in the picture — it just stops
// contributing, and the network quietly thins.
vec2 p = (q * 2.0 - 1.0) * 4000.0;

vec2 w = agWrap(p, size);
float inside = (w.x >= 0.0 && w.x < size.x && w.y >= 0.0 && w.y < size.y) ? 1.0 : 0.0;
// Idempotent: wrapping an already-wrapped position changes nothing.
float idem = step(length(agWrap(w, size) - w), 1.0e-4);
// And it is a TRANSLATION by a whole number of field widths, not a fold or a
// clamp: a clamp would also land inside, and would pile agents on the edge.
vec2 k = (p - w) / size;
float translation = step(length(k - floor(k + 0.5)), 1.0e-3);

ok = vec3(inside, idem, translation);
`,
    }, N);
    const c = countFailures(img);
    check('agWrap lands inside the field for any input, negative included',
      c.failed[0] === 0, describe(c, ['inside', 'idempotent', 'a whole-field translation']));
    check('agWrap is idempotent and is a translation, not a clamp',
      c.failed[1] === 0 && c.failed[2] === 0,
      describe(c, ['inside', 'idempotent', 'a whole-field translation']));
  }
} finally {
  await s.close();
}
