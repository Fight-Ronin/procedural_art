#pragma once
#include "core/const.glsl"
#include "metric/wormhole.glsl"

// Light in a spherically symmetric spacetime: three numbers and one step.
//
// THE STATE IS THREE NUMBERS, NOT FIVE, and the reduction is the reason this
// module is short enough to be checked. The metric is spherically symmetric, so
// every null geodesic stays in the plane spanned by the observer's position and
// the ray's initial direction. Work in that plane and the full system
//
//     (l, theta, phi, p_l, p_theta)          five states, two conserved
//
// collapses to
//
//     y = (l, psi, p_l)                      three states, one conserved
//
//     dl/dxi   = p_l
//     dpsi/dxi = b / r^2
//     dp_l/dxi = b^2 r'(l) / r^3
//
// where `b` is the impact parameter, constant along the ray. Three things are
// bought by that, and the third is the one that matters:
//
//   the state is smaller, so the marching loop is cheaper per pixel;
//   b stops being an integrated quantity and becomes an argument, so its
//     conservation is STRUCTURAL rather than something the integrator has to
//     maintain;
//   THE POLAR SINGULARITY DISAPPEARS. The five-state form carries
//     dp_theta/dxi = (b^2/r^2) cos(theta)/sin^3(theta), which blows up on the
//     axis. In an image that is a scanline of NaN through the exact middle of
//     the frame — the place the composition puts the wormhole. There is no
//     theta here at all, so there is nothing to be on the axis of.
//
// The caller maps the plane back to three dimensions with two vectors it
// already has: the observer's angular position n0 and the unit tangent t of the
// ray's sideways component. The angular position after sweeping psi is then
// simply cos(psi) n0 + sin(psi) t.
//
// AFFINE PARAMETER = PROPER LENGTH. With the normalisation below (E = 1, so
// p_l^2 + b^2/r^2 = 1) the three velocity components square to exactly 1 in the
// static frame, which means xi IS distance. So a volume integrator riding along
// this ray passes `h` straight to `volStep` with no conversion — the thing 009
// got wrong in its first version, made impossible here rather than remembered.
//
// WHY THERE IS NO INTEGRATOR-WITH-A-LOOP, only a step: the same reason
// `volume/emission.glsl` and `field/flow.glsl` stop where they do. But note the
// hole those two were avoiding is NOT open here — the metric this steps through
// lives in basics/ beside it, so `mtGeoStep` is a completely pure function of
// (state, h, b, wormhole) and needs no prototype for the caller to fill in. The
// loop stays in the artwork because the TERMINATION is the artwork's business:
// when to stop, which sky to sample, what to do with a ray that ran out of
// budget.

/** Impact parameter of a ray leaving `l` at angle `alpha` to the radial. */
float mtGeoImpact(float l, float sinAlpha, MtWormhole w) {
    return mtRadius(l, w) * sinAlpha;
}

/** The right-hand side of the geodesic system. */
vec3 mtGeoDeriv(vec3 y, float b, MtWormhole w) {
    float r = mtRadius(y.x, w);
    float dr = mtSlope(y.x, w);
    float ir = 1.0 / r;
    return vec3(y.z, b * ir * ir, b * b * dr * ir * ir * ir);
}

/**
 * One classical fourth-order Runge-Kutta step of size `h`.
 *
 * `h` is a LENGTH (see the note above), and it may be negative — integrating
 * with -h is the exact time reversal of integrating with +h, which is the
 * cheapest strong check there is on the whole system and is what
 * `test/metric.test.ts` uses. Reversing by flipping p_l alone does NOT work:
 * dpsi/dxi = b/r^2 has one sign for the whole ray, so the sweep keeps
 * accumulating and the ray comes back to the right place having gone the long
 * way round. (Flipping p_l AND b together does work, and agrees with -h to the
 * last bit.)
 *
 * FOURTH ORDER, AND THAT IS NOT THE INTERESTING PART. Measured against the null
 * invariant in 32-bit float over a span of 24 units: the residual falls 2.2e-3,
 * 8.0e-5, 2.2e-6 as h goes 1.6, 0.8, 0.4 — and then STOPS falling, reaching
 * 1.2e-7 at h = 0.1 and getting WORSE again at h = 0.05, where round-off
 * accumulated over 480 steps beats truncation. Forward Euler at h = 0.4 gives
 * 3.9e-1, five orders of magnitude away, which is why it is the control.
 *
 * The consequence for a piece: more steps is not monotonically better, so the
 * step count is not a quality knob. It changes the PATH, not the noise, and two
 * step counts are two different pictures rather than a rough one and a smooth
 * one. Gating it on uQuality — the reflex everywhere else in this repo — would
 * make the print a different image from the preview.
 */
void mtGeoStep(inout vec3 y, float h, float b, MtWormhole w) {
    vec3 k1 = mtGeoDeriv(y, b, w);
    vec3 k2 = mtGeoDeriv(y + k1 * (h * 0.5), b, w);
    vec3 k3 = mtGeoDeriv(y + k2 * (h * 0.5), b, w);
    vec3 k4 = mtGeoDeriv(y + k3 * h, b, w);
    y += (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
}

/**
 * How far the state has drifted off the null condition p_l^2 + b^2/r^2 = 1.
 *
 * An exact invariant of the continuous system — differentiate it and the two
 * terms cancel identically — so any nonzero value is the integrator's error and
 * nothing else. That is what makes it worth carrying: it is a residual with no
 * physics in it, available at every step, and it costs one radius evaluation.
 */
float mtGeoNull(vec3 y, float b, MtWormhole w) {
    float r = mtRadius(y.x, w);
    return abs(y.z * y.z + b * b / (r * r) - 1.0);
}

/**
 * The sweep the ray has left to accumulate between here and infinity.
 *
 * Once r' has reached 1 the far field is flat, dpsi/dr -> b/r^2, and the tail
 * integrates in closed form to b/r. Adding it lets the marching stop at a
 * modest |l| instead of chasing an asymptote: measured on a ray with b = 1.75,
 * stopping at |l| = 20 leaves an error of 0.099 rad, and 0.0011 rad with this
 * correction — ninety times better for one divide, and the difference between
 * a sky that shears visibly when the exit radius is changed and one that does
 * not. It is also what keeps a fixed step size affordable, since the span that
 * has to be marched no longer grows with the accuracy wanted.
 */
float mtGeoTail(vec3 y, float b, MtWormhole w) {
    return b / mtRadius(y.x, w);
}

/**
 * How much a pixel's solid angle is stretched by the lensing.
 *
 * The map from a viewing direction to a sky direction is (theta, phi) ->
 * (Psi(theta), phi): spherical symmetry means the azimuth passes through
 * untouched and only the polar angle moves, where `theta` is measured from the
 * INWARD radial direction and `Psi` from the observer's own position on the
 * sphere. The area element on each side is then sin(angle) d(angle) dphi, so
 *
 *     dOmega_sky / dOmega_camera = (sin Psi / sin theta) |dPsi/dtheta|
 *
 * which is the classical gravitational-lensing magnification, and it needs only
 * ONE extra ray — a second-order finite difference in theta — rather than the
 * two a full 2x2 Jacobian would take. `test/metric.test.ts` checks it against a
 * spherical area computed from four independently traced corners, which agrees
 * to 3e-6 away from the critical angle.
 *
 * IT IS NOT A BRIGHTNESS. Lensing conserves surface brightness, so an extended
 * source is not made brighter by this; what the number is for is knowing how
 * much sky one pixel covers, which is the difference between a point source
 * that aliases and one that is filtered. Near the axis and near the critical
 * angle it runs into the hundreds — a pixel there genuinely sees a huge swathe
 * of sky wound into a ring — so a caller wanting a filter width should cap it.
 *
 * Both sines are guarded: on the axis theta and Psi go to zero together and the
 * ratio has a finite limit, but the expression does not.
 */
float mtLensMag(float sinTheta, float psi, float dPsiDtheta) {
    float num = abs(sin(psi));
    float den = max(abs(sinTheta), 1.0e-5);
    return num / den * abs(dPsiDtheta);
}
