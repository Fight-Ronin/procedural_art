#pragma once
#include "core/const.glsl"

/**
 * The pointwise parts of Kobayashi's (1993) anisotropic phase-field model of
 * solidification from an undercooled melt.
 *
 *   tau dphi/dt = d/dy(eps eps' phi_x) - d/dx(eps eps' phi_y)
 *               + div(eps^2 grad phi) + phi (1 - phi)(phi - 1/2 + m(T))
 *   dT/dt       = lap T + K dphi/dt
 *
 * phi is 0 in the liquid and 1 in the solid; T is a dimensionless temperature
 * with the melting point at T_eq; K is the latent heat released per unit of
 * phi. The interface is a smooth profile a few cells wide, which is what lets
 * the model grow dendrites without ever tracking a boundary.
 *
 * Everything with a neighbourhood — the divergences, the Laplacians — is the
 * caller's, assembled from `pde/stencil.glsl` over texture reads. What is here
 * is the physics at a point: the anisotropy and the driving force.
 *
 * THIS IS A MELT, NOT A SNOWFLAKE. The model is thermal: growth is limited by
 * how fast latent heat diffuses away, and side branches come from the
 * Mullins-Sekerka instability (Mullins & Sekerka 1964) of a front in a
 * diffusion field. Snow grows from vapour and is governed by attachment
 * kinetics, which produce facets this model does not have (Libbrecht 2005).
 * It draws dendrites that look like snow because both are diffusion-limited.
 */

/**
 * Interface energy and its angular derivative, as vec2(eps, deps/dtheta).
 *
 *   eps(theta) = epsBar (1 + delta cos(j (theta - theta0)))
 *
 * `theta` is the direction of grad phi. `j` is the symmetry (6 hexagonal,
 * 4 cubic). The cross terms in the evolution equation use eps * eps', and are
 * what make the anisotropy a STIFFNESS rather than only an energy — they are
 * the part common simplifications drop, and without them delta barely acts.
 */
vec2 pfEps(float theta, float epsBar, float delta, float j, float theta0) {
    float a = j * (theta - theta0);
    return vec2(epsBar * (1.0 + delta * cos(a)), -epsBar * j * delta * sin(a));
}

/**
 * pfEps for the direction of a gradient `g`, with no trigonometry.
 *
 * For integer j, cos(j theta) and sin(j theta) are the real and imaginary
 * parts of (g / |g|)^j as a complex number, so the angle never has to be
 * computed. The reason is correctness more than speed: the angle is undefined
 * where g = 0, which is the whole liquid and the whole solid, and an undefined
 * atan can be NaN, while this form is well defined there. (It is also cheaper —
 * measured at 30% of a step on a software rasteriser, where a fixed per-draw
 * cost dominates small grids anyway.)
 * `cs0` is (cos, sin) of j theta0. Agrees with pfEps(atan(g.y, g.x), ...) —
 * test/crystal.test.ts holds the two to rounding.
 */
vec2 pfEpsDir(vec2 g, float epsBar, float delta, int j, vec2 cs0) {
    float l2 = dot(g, g);
    if (l2 == 0.0) return vec2(epsBar * (1.0 + delta * cs0.x), epsBar * float(j) * delta * cs0.y);
    vec2 n = g * inversesqrt(l2);
    vec2 z = vec2(1.0, 0.0);
    for (int k = 0; k < j; ++k) z = vec2(z.x * n.x - z.y * n.y, z.x * n.y + z.y * n.x);
    // z = e^{i j theta}; multiply by e^{-i j theta0}.
    vec2 r = vec2(z.x * cs0.x + z.y * cs0.y, z.y * cs0.x - z.x * cs0.y);
    return vec2(epsBar * (1.0 + delta * r.x), -epsBar * float(j) * delta * r.y);
}

/**
 * The largest anisotropy for which the interface stiffness eps + eps'' stays
 * positive in every direction: delta < 1 / (j^2 - 1).
 *
 * Past it the equation is ill-posed — some orientations have negative
 * stiffness and the front develops corners and missing orientations that
 * depend on the grid rather than the physics. For j = 6 the limit is 1/35,
 * about 0.0286, which is why the useful range of delta is so narrow.
 */
float pfStiffLimit(float j) {
    return 1.0 / (j * j - 1.0);
}

/**
 * Direction of grad phi, defined everywhere.
 *
 * atan(0, 0) is undefined in GLSL, and the gradient is exactly zero across the
 * whole liquid and the whole solid. The value chosen there does not matter —
 * every term it feeds is multiplied by the gradient — but an undefined value
 * can be NaN, and NaN times zero is NaN.
 */
float pfTheta(vec2 g) {
    return dot(g, g) > 0.0 ? atan(g.y, g.x) : 0.0;
}

/**
 * Driving force m(T) = (alpha / pi) atan(gamma (T_eq - T)).
 *
 * Positive below the melting point, so the solid grows; negative above, so it
 * melts. Bounded by alpha / 2 so that the double well keeps both minima.
 */
float pfDrive(float t, float tEq, float alpha, float gamma) {
    return alpha / PI * atan(gamma * (tEq - t));
}

/** The double-well reaction, tilted by the driving force `m`. */
float pfReaction(float phi, float m) {
    return phi * (1.0 - phi) * (phi - 0.5 + m);
}
