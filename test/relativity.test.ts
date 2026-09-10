/**
 * The boost, and the exponent it implies.
 *
 * Aberration is four lines of algebra whose failure mode is a picture: get a
 * sign wrong and the sky crowds together BEHIND the camera instead of ahead of
 * it, which is a striking image and completely false. So the suite is built out
 * of statements that hold exactly rather than approximately, and the strongest
 * of them is geometric: `relAberrate` maps the unit sphere onto itself, it is
 * its own inverse under beta -> -beta, and the AREA it multiplies a patch of
 * sphere by is exactly D squared.
 *
 * That last one is why this suite exists in the shape it does. `relBeam` raises
 * the Doppler factor to the FOURTH power, and four is the number everyone gets
 * wrong — it is one factor of D for photon energy, one for the rate they
 * arrive, and TWO from solid angle. The third of those is measured here from
 * the aberration map itself, so the exponent is derived rather than declared
 * next to a citation, and a wrong aberration takes the exponent down with it.
 *
 * The blackbody is in the same file because it exists only to carry that shift:
 * D scales a spectrum, an RGB triple has nothing to scale, and a Planck curve
 * scaled in frequency by D is exactly a Planck curve at D times the
 * temperature. Its one dangerous property is the normalisation — a blackbody's
 * radiance already goes as T^4, which IS the beaming factor, so the colour has
 * to carry none of it.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('relativity');

/** A direction and a speed per pixel, spread over the sphere and over beta. */
const SETUP = `
vec2 uv = (pix + 0.5) / n;
float ct = mix(-0.995, 0.995, uv.x);
float ph = uv.y * 19.0;
// NORMALISED, and that is not belt-and-braces. Built without it, this vector
// is off unit length by more than 1e-5 over four fifths of the grid: GLSL ES
// guarantees only a few ULP for sin and cos, and ph runs to 19 radians where
// argument reduction has already spent them. The first version of this suite
// reported that as relAberrate failing to return a unit vector — the map was
// exact and the SAMPLE POINTS were not.
vec3 s = normalize(vec3(sqrt(1.0 - ct * ct) * cos(ph), sqrt(1.0 - ct * ct) * sin(ph), ct));
vec3 u = normalize(vec3(0.21, -0.37, 0.90));
float beta = mix(-0.95, 0.95, fract(uv.y * 7.0));
`;

const s = await launch(5233);
try {
  // --- the map is an isometry of the sphere ----------------------------------
  {
    const img = await runProbe(s, {
      includes: ['relativity/boost.glsl'],
      body: `${SETUP}
vec3 a = relAberrate(s, u, beta);

// NO normalize() APPEARS IN relAberrate. The algebra returns a unit vector on
// its own, and checking that here is what keeps someone from "fixing" it with a
// normalize() that would hide a genuinely wrong direction behind a right length.
float unit = step(abs(length(a) - 1.0), 1.0e-5);

// Aberrating back by -beta is the inverse boost, so it must return the original
// direction. This is the check that a sign error cannot survive.
float back = step(length(relAberrate(a, u, -beta) - s), 2.0e-5);

// A stationary camera changes nothing.
float rest = step(length(relAberrate(s, u, 0.0) - s), 1.0e-6);

ok = vec3(unit, back, rest);
`,
    }, 48);
    const c = countFailures(img);
    check('relAberrate returns a unit vector without normalising one',
      c.failed[0] === 0, describe(c, ['unit length', 'inverse by -beta', 'beta 0 is the identity']));
    check('aberrating by -beta undoes aberrating by +beta',
      c.failed[1] === 0, describe(c, ['unit', 'inverse', 'rest']));
    check('a camera at rest sees undeflected directions',
      c.failed[2] === 0, describe(c, ['unit', 'inverse', 'rest']));
  }

  // --- the Doppler factor, twice, and where it crosses 1 ---------------------
  {
    const img = await runProbe(s, {
      includes: ['relativity/boost.glsl'],
      body: `${SETUP}
vec3 a = relAberrate(s, u, beta);
float d1 = relDoppler(s, u, beta);          // from the camera-frame direction
float d2 = relDopplerStatic(a, u, beta);    // from the aberrated one

// The two forms are computed from different quantities by different
// expressions, so their agreement is a constraint linking the aberration to
// the Doppler factor. Break the aberration and this fails even though each
// function alone still returns something plausible.
float agree = step(abs(d1 - d2), 1.0e-4 * max(d1, 1.0));

// D > 1 exactly when beta * cos > 1 - 1/gamma. Written multiplied through by
// beta ON PURPOSE: dividing gives the threshold cos = (1 - 1/gamma)/beta, and
// then the inequality SILENTLY REVERSES for beta < 0. That is what the first
// version did, and it failed on exactly half the grid — the receding half.
float lhs = beta * dot(s, u);
float rhs = 1.0 - sqrt(1.0 - beta * beta);
float side = (d1 > 1.0) == (lhs > rhs) ? 1.0 : 0.0;
if (abs(lhs - rhs) < 1.0e-4) side = 1.0;   // the crossing itself

float finite = (d1 > 0.0 && d1 < 1.0e6 && d1 == d1) ? 1.0 : 0.0;

ok = vec3(agree, side, finite);
`,
    }, 48);
    const c = countFailures(img);
    check('the camera-frame and static-frame Doppler factors agree',
      c.failed[0] === 0, describe(c, ['two forms agree', 'crosses 1 where the closed form says', 'positive and finite']));
    check('D crosses 1 exactly at (1 - sqrt(1-beta^2))/beta',
      c.failed[1] === 0, describe(c, ['agree', 'crossing', 'finite']));
    check('D is positive and finite for every direction and speed',
      c.failed[2] === 0, describe(c, ['agree', 'crossing', 'finite']));
  }

  // --- the fourth power, derived --------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['relativity/boost.glsl'],
      decls: `
// Area of the little parallelogram spanned by two neighbours of s on the
// sphere, before and after aberration. The ratio of the two is the solid angle
// magnification of the map.
float patchRatio(vec3 s, vec3 u, float beta, float e, out float before) {
    vec3 t1 = normalize(cross(s, abs(s.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(s, t1);
    vec3 p0 = s;
    vec3 p1 = normalize(s + t1 * e);
    vec3 p2 = normalize(s + t2 * e);
    before = length(cross(p1 - p0, p2 - p0));
    vec3 a0 = relAberrate(p0, u, beta);
    vec3 a1 = relAberrate(p1, u, beta);
    vec3 a2 = relAberrate(p2, u, beta);
    return length(cross(a1 - a0, a2 - a0)) / max(before, 1.0e-30);
}
`,
      body: `${SETUP}
float before;
float ratio = patchRatio(s, u, beta, 3.0e-3, before);
float d = relDoppler(s, u, beta);

// THE SOLID ANGLE FACTOR IS D SQUARED. This is the half of the fourth power
// that is not obvious, and measuring it here is what turns relBeam's exponent
// from a citation into a consequence.
float area = step(abs(ratio / (d * d) - 1.0), 0.02);

// Control: the map has to actually DO something, or the line above is
// satisfied by an aberration that returns its argument. Excluding the ring
// where D == 1 is not a let-off — the magnification IS exactly 1 there, since
// it is D^2, so a control that demanded otherwise would be asserting the
// opposite of the thing being tested.
float moves = (abs(beta) < 0.25 || abs(d - 1.0) < 0.1)
    ? 1.0 : step(0.08, abs(ratio - 1.0));

// And the composite: energy x rate x solid angle = D x D x D^2.
float beam = step(abs(relBeam(d) - d * d * ratio), 0.03 * relBeam(d));

ok = vec3(area, moves, beam);
`,
    }, 48);
    const c = countFailures(img);
    check('aberration multiplies solid angle by exactly D squared',
      c.failed[0] === 0, describe(c, ['ratio is D^2', 'the map moves things (control)', 'relBeam = D x D x solid angle']));
    check('the aberration is not a no-op at speed (control)',
      c.failed[1] === 0, describe(c, ['D^2', 'control', 'composite']));
    check('relBeam D^4 equals energy x rate x measured solid angle',
      c.failed[2] === 0, describe(c, ['D^2', 'control', 'composite']));
    note('so the exponent 4 is a measurement here, not a citation');
  }

  // --- the blackbody that carries the shift ----------------------------------
  {
    const img = await runProbe(s, {
      includes: ['color/blackbody.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
float T = 1200.0 * pow(40000.0 / 1200.0, uv.x);   // 1200 K .. 40000 K, log spaced
vec3 c = colBlackbody(T);

// NO BRIGHTNESS. The colour is a chromaticity and nothing else, because the
// T^4 that a real blackbody carries is the same factor relBeam already applies.
float unitLuma = step(abs(colLumaLinear(c) - 1.0), 1.0e-3);

// Hotter is bluer, everywhere, with no reversal. A transposed coefficient in
// the colour matching fit still gives a smooth ramp — just the wrong one — and
// this is the cheapest statement that separates them.
//
// STRICT only where there is blue to compare. Below about 2000 K the Planckian
// red is outside the sRGB gamut, the blue channel clamps to exactly zero, and
// two zeroes are equal rather than increasing — a property of the gamut, not of
// the ramp. There the weaker statement is the true one.
vec3 hot = colBlackbody(T * 1.25);
float lo = c.b / max(c.r, 1.0e-6);
float hi = hot.b / max(hot.r, 1.0e-6);
float bluer = hot.b > 0.01 ? step(lo + 1.0e-4, hi) : step(lo, hi + 1.0e-6);

// The 32-sample integral is the one the artwork pays for; 64 is the most this
// module will do. They must already agree, or the cheap one is a different
// function rather than a cheaper one.
vec3 fine = colBlackbody(T, 64);
float converged = step(length(c - fine), 5.0e-3);

ok = vec3(unitLuma, bluer, converged);
`,
    }, 48);
    const c = countFailures(img);
    check('colBlackbody carries no brightness: luminance is exactly 1',
      c.failed[0] === 0, describe(c, ['unit luminance', 'hotter is bluer', '32 samples agree with 64']));
    check('hotter is bluer at every temperature, with no reversal',
      c.failed[1] === 0, describe(c, ['unit luminance', 'monotone', 'converged']));
    check('the 32-sample integral agrees with the 64-sample one',
      c.failed[2] === 0, describe(c, ['unit luminance', 'monotone', 'converged']));
  }

  // --- an anchor with a known answer ----------------------------------------
  //
  // Everything above is internally consistent, and a colour matching fit with
  // two rows swapped would satisfy all of it. This is the only check that
  // reaches outside: a 6504 K blackbody is the D65 white point, so it has to
  // come out neutral. Measured 4% off on the worst channel, which is the
  // accuracy of the Gaussian fit rather than a defect.
  {
    const img = await runProbe(s, {
      includes: ['color/blackbody.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
vec3 white = colBlackbody(6504.0);
float neutral = step(max(max(abs(white.r - 1.0), abs(white.g - 1.0)), abs(white.b - 1.0)), 0.06);

// A cold body is red and a hot one is blue, with a wide gap between them: the
// control that stops the normalisation above from passing a constant function.
vec3 cold = colBlackbody(1800.0);
vec3 hot = colBlackbody(20000.0);
float spread = step(0.5, cold.r - hot.r) * step(0.5, hot.b - cold.b);

float positive = (cold.r >= 0.0 && cold.g >= 0.0 && cold.b >= 0.0 &&
                  hot.r >= 0.0 && hot.g >= 0.0 && hot.b >= 0.0) ? 1.0 : 0.0;

ok = vec3(neutral, spread, positive);
`,
    }, 16);
    const c = countFailures(img);
    check('6504 K comes out neutral, which is the one check that is not self-consistency',
      c.failed[0] === 0, describe(c, ['D65 is neutral to 6%', 'cold vs hot are far apart (control)', 'no negative channels']));
    check('a cold body and a hot one are far apart (control)',
      c.failed[1] === 0, describe(c, ['neutral', 'spread', 'non-negative']));
    check('no channel comes back negative after the gamut clamp',
      c.failed[2] === 0, describe(c, ['neutral', 'spread', 'non-negative']));
  }
} finally {
  await s.close();
}
