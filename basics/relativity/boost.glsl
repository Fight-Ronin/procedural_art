#pragma once

// What a fast observer sees: where a direction goes, and how much brighter it
// gets when it goes there.
//
// This is flat-space special relativity and it has nothing to do with the
// metric next door — which is exactly why it is its own directory. A boost acts
// in the observer's LOCAL orthonormal frame, at one point, and a curved
// spacetime is by construction locally flat, so these two things compose
// without either knowing about the other: 012 aberrates a direction here, hands
// it to the geodesic integrator in `metric/`, and multiplies whatever comes
// back by the factor computed here. Neither module gains a parameter.
//
// EVERYTHING BELOW TRANSFORMS A VIEWING DIRECTION, not a photon's direction of
// travel. The two are opposite, and a backward ray tracer holds the first one:
// `s` points FROM the camera TOWARD the source. Writing the formulae for the
// propagation direction and then feeding them a viewing direction is a sign
// error that produces a perfectly plausible picture with the sky compressed
// behind the camera instead of in front of it.
//
// With the camera moving at `beta` (in units of c) along a unit vector `u`,
// splitting `s` into components along and across `u`:
//
//     s_par  = (s'_par - beta) / (1 - beta s'_par)
//     s_perp =  s'_perp / (gamma (1 - beta s'_par))
//
// where primes are the camera's frame and unprimed the static one. Two
// properties fall out that `test/relativity.test.ts` holds to machine precision
// rather than trusting: the result is a UNIT VECTOR with no normalise() in
// sight, and aberrating by -beta undoes aberrating by +beta.

/**
 * Where the camera's viewing direction `s` actually points in the static frame.
 *
 * `u` is the unit direction of the camera's motion and `beta` its speed in
 * units of c. Returns a unit vector; the algebra normalises itself, which is
 * why there is no normalize() here and why the test checks for one.
 *
 * The Lorentz factor is 1.0 / sqrt() rather than inversesqrt() because GLSL ES
 * allows the latter a couple more ULP, and the self-normalising algebra above
 * is only as exact as gamma is. Measured on this driver the two are
 * indistinguishable — the unit-length property holds to 1.7e-6 either way — so
 * this is a precision guarantee taken because it is free, not a bug fixed.
 */
vec3 relAberrate(vec3 s, vec3 u, float beta) {
    float g = 1.0 / sqrt(max(1.0 - beta * beta, 1.0e-12));
    float sp = dot(s, u);
    vec3 perp = s - sp * u;
    float den = 1.0 - beta * sp;
    return u * ((sp - beta) / den) + perp / (g * den);
}

/**
 * The Doppler factor D = E_observed / E_static, from the CAMERA-frame viewing
 * direction — the one you have before aberrating.
 *
 * Looking forward gives D > 1 (blueshift, and the sky ahead crowds together);
 * looking back gives D < 1. At beta = 0.5 the front of the sky comes in at
 * D = 1.73 and the back at 0.58.
 */
float relDoppler(vec3 s, vec3 u, float beta) {
    float g = 1.0 / sqrt(max(1.0 - beta * beta, 1.0e-12));
    return 1.0 / (g * (1.0 - beta * dot(s, u)));
}

/**
 * The same D, from the STATIC-frame viewing direction — the one you have after
 * aberrating.
 *
 * Both forms exist because their agreement is a real constraint linking
 * `relAberrate` to `relDoppler`: get the aberration slightly wrong and these
 * two stop matching, while each on its own still looks reasonable. The test
 * uses it as a cross-check, and a caller that has already aberrated can use it
 * instead of keeping the original direction alive.
 */
float relDopplerStatic(vec3 s, vec3 u, float beta) {
    float g = 1.0 / sqrt(max(1.0 - beta * beta, 1.0e-12));
    return g * (1.0 + beta * dot(s, u));
}

/**
 * How much brighter a surface brightness gets: D to the FOURTH.
 *
 * One line, and it exists so the exponent has somewhere to be explained,
 * because 4 is the number everyone gets wrong. Radiance is energy per unit
 * time, area and solid angle, and the boost hits three of those:
 *
 *     energy       x D
 *     1 / time     x D
 *     1 / solid angle  x D^2   <- the one that is not obvious
 *
 * The last factor is the headlight effect, and it is not an assumption here:
 * `test/relativity.test.ts` measures the area of a small quadrilateral on the
 * sphere before and after `relAberrate` and requires the ratio to be exactly
 * D^2. So the fourth power is derived from the aberration map rather than
 * asserted beside it — if the map were wrong, the exponent test would fail too.
 *
 * Equivalently, and more compactly: the ratio I_nu / nu^3 is a Lorentz
 * invariant, so the bolometric radiance goes as the fourth power of frequency.
 */
float relBeam(float d) {
    float d2 = d * d;
    return d2 * d2;
}
