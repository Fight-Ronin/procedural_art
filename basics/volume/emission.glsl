#pragma once
#include "core/math.glsl"

// Emission-absorption volume integration: the light a ray picks up crossing
// something that glows and blocks.
//
// Seven pieces in, everything this repo could render was a surface with light
// arriving from outside it. 006 marches a volume, but its scattering loop is
// written inline in the artwork, and 002's absorption is Beer-Lambert along a
// straight segment. Neither is the integral below, and nothing in basics/ was.
//
// THIS MODULE IS THE STEP, NOT THE LOOP, and that is deliberate. A whole
// integrator would need the artwork's density and emission functions, and GLSL
// has no function pointers — so it would need a second undefined prototype
// beside `sceneSdf`, which `test/layers.test.ts` exists to prevent. One hole is
// an unavoidable exception; two is a pattern. `field/flow.glsl` refused the
// same temptation. So the artwork owns the loop and calls `volStep` per sample,
// and everything with mathematics in it lives here where it can be tested.
//
// The integral, front to back:
//
//     L = INTEGRAL T(s) sigma(s) Le(s) ds,   T(s) = exp(-INTEGRAL sigma du)
//
// where sigma is extinction (per unit length) and Le is the SOURCE RADIANCE —
// what the medium emits per unit of extinction, not per unit of length. That
// distinction is the whole reason `volStep` has no sigma in its emission term:
// over a segment of constant sigma the two sigmas cancel exactly, leaving
// Le * (1 - exp(-sigma h)). Writing `L += T * sigma * h * Le` instead is the
// first-order approximation of that, and it is what makes a dense volume come
// out too bright and its brightness depend on the step count.

/** Transmittance through a slab of extinction `sigma` and thickness `h`. */
float volTransmit(float sigma, float h) {
    return exp(-sigma * h);
}

/**
 * One front-to-back emission-absorption step, EXACT for constant sigma and Le
 * over the segment — at any step size, not merely in the limit.
 *
 * `L` accumulates radiance and `T` carries the transmittance still remaining;
 * start them at 0 and 1. `emission` is source radiance (see the note above),
 * `sigma` extinction per unit length, `h` the segment length.
 *
 * Exactness at any h is the property worth having and the one
 * `test/volume.test.ts` checks against the closed form: it means halving the
 * step count changes the picture only through how well the STEPS resolve the
 * density field, never through the integrator itself. With the first-order
 * form the two are tangled, and "more steps" quietly also means "darker".
 */
void volStep(inout vec3 L, inout float T, vec3 emission, float sigma, float h) {
    float t = exp(-sigma * h);
    L += T * (1.0 - t) * emission;
    T *= t;
}

/**
 * Radiance and transmittance of a UNIFORM slab, in closed form.
 *
 * Not used by the marching loop — it is what the loop is checked against, and
 * it is here rather than in the test so that the claim and the code that makes
 * it live together. `T` comes back through the inout, `L` is returned.
 */
vec3 volSlab(vec3 emission, float sigma, float length_, out float T) {
    T = exp(-sigma * length_);
    return emission * (1.0 - T);
}

/**
 * Henyey-Greenstein phase function, normalised so it integrates to 1 over the
 * sphere.
 *
 * `g` in (-1, 1): 0 is isotropic, positive scatters forward, negative back.
 * Clamped away from the ends, where the lobe becomes a delta and the
 * denominator goes to zero.
 */
float volPhaseHg(float cosTheta, float g) {
    g = clamp(g, -0.95, 0.95);
    float g2 = g * g;
    float d = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * PI * d * sqrt(max(d, 1e-8)));
}

/**
 * How far a ray travels through a sphere, as an entry/exit pair.
 *
 * Returned as (near, far); `far < near` means a miss. Marching a bounded volume
 * without this means either stepping through empty space to find it — which at
 * a useful step count is most of the budget — or bounding it by a fixed range
 * that is wrong as soon as the camera moves.
 */
vec2 volSphereSpan(vec3 ro, vec3 rd, vec3 centre, float radius) {
    vec3 oc = ro - centre;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}
