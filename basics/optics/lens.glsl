#pragma once
#include "core/math.glsl"

// The lens map: where a ray through a phase screen lands, and what happens to
// the bundle around it.
//
// A thin sheet of varying optical thickness — a water surface, a pane of glass,
// a cloud of mass — deflects a ray by an angle proportional to the gradient of
// its phase. At a distance downstream the ray has moved sideways by that angle
// times the distance, so the map from a point on the sheet to a point on the
// receiver is
//
//     x(u) = u - a * grad(phi)(u)
//
// with a single number `a` carrying the distance and the strength together.
// Its Jacobian is `I - a * Hess(phi)`, so everything about the picture — where
// it is bright, where the lines are, how many rays arrive at a point — is a
// statement about the second derivative of the phase.
//
// THIS IS THE GRAVITATIONAL LENS EQUATION. 012 already solves it in the other
// direction, with the projected potential of a mass in place of the thickness
// of water; `claude/lensing-jacobian-and-offaxis.md` is the same algebra. The
// two pieces are the same optics at a difference of forty orders of magnitude
// in scale, which is worth saying once in the library rather than twice in the
// artworks.
//
// Paraxial, deliberately. The exact refraction of a wavy surface is Snell's law
// at every point, which `optics/glass.glsl` already does; the linear form here
// is the one whose caustic structure is the classical fold-and-cusp geometry
// rather than an approximation of it. A piece that wants the exact surface
// should trace it, not tilt this.

/**
 * Where the ray through `u` lands, given the phase gradient there.
 *
 * `a` folds the propagation distance and the phase strength into one number,
 * because nothing downstream can tell them apart: doubling the distance and
 * halving the relief give the identical picture. Two knobs for one degree of
 * freedom is how a parameter sweep ends up exploring a diagonal.
 */
vec2 optLensMap(vec2 u, vec2 grad, float a) {
    return u - a * grad;
}

/**
 * Determinant of the map's Jacobian, `det(I - a H)`.
 *
 * ITS ZERO SET IS THE CAUSTIC. Expanded in the two invariants of H,
 *
 *     det J = 1 - a * tr(H) + a^2 * det(H)
 *
 * which is a quadratic in `a` whose roots are the reciprocals of the principal
 * curvatures — that is, the local focal lengths. So the caustic is not a
 * separate object to be found: it is where the receiver has been placed at the
 * focal distance of the local curvature, and sweeping `a` sweeps the whole
 * fold-and-cusp unfolding.
 *
 * Flux conservation makes the intensity `sum over preimages of 1/|det J|`, so
 * this diverges on the caustic. A forward scatter never evaluates that
 * reciprocal — the density of landed rays IS the intensity — which is the
 * reason to plot a caustic by scattering rather than by gathering, over and
 * above the reason 010 gives.
 *
 * Its SIGN is worth as much as its zero: it flips each time a ray crosses a
 * fold, so it labels which sheet of the multiply-imaged region a ray belongs
 * to. That is a real distinction in the picture and it costs nothing here.
 */
float optLensDetJ(mat2 hess, float a) {
    float tr  = hess[0][0] + hess[1][1];
    float det = hess[0][0] * hess[1][1] - hess[0][1] * hess[1][0];
    return 1.0 - a * tr + a * a * det;
}

/**
 * The two principal curvatures of the phase, larger first.
 *
 * `a = 1 / kappa` is where that direction focuses, so these say what range of
 * `a` a given field actually has caustics in — which is the difference between
 * a distance knob that reaches the picture and one that does not.
 *
 * The discriminant is written as `(h00 - h11)^2 + 4 h01^2` rather than as
 * `tr^2 - 4 det`. The two are equal in exact arithmetic, but only the first is
 * manifestly non-negative: the second is a difference of two comparable
 * quantities and goes slightly negative near a point of equal curvature, where
 * the sqrt then returns NaN. Designing that out beats clamping it away, and a
 * clamp would have hidden it — the NaN appears only at umbilics, which are
 * isolated points, so it would have shown up as a few poisoned pixels rather
 * than as a wrong formula.
 */
vec2 optLensCurvature(mat2 hess) {
    float tr = hess[0][0] + hess[1][1];
    float d  = hess[0][0] - hess[1][1];
    float disc = sqrt(d * d + 4.0 * hess[0][1] * hess[0][1]);
    return 0.5 * vec2(tr + disc, tr - disc);
}
