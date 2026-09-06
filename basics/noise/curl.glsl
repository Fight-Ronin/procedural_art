#pragma once
#include "core/math.glsl"
#include "noise/deriv.glsl"

// Divergence-free velocity fields, built as the curl of a scalar potential.
//
// In two dimensions the curl of a scalar streamfunction psi is
//
//     v = ( dpsi/dy, -dpsi/dx )
//
// and its divergence is dv.x/dx + dv.y/dy = psi_yx - psi_xy, which is zero for
// any twice-differentiable psi. That is the whole trick, and it is why flow
// built this way looks like a fluid: nothing accumulates and nothing thins out,
// because the field has no sources or sinks anywhere.
//
// It also means v is everywhere PERPENDICULAR to grad(psi) and of exactly the
// same length — so streamlines are the level sets of psi. Both of those are
// algebraic identities rather than approximations, which makes them worth
// testing: they hold to machine precision if the derivative is right and fail
// visibly if it is not.
//
// The derivatives come from `noise/deriv.glsl` analytically. Taking them by
// finite differences would leave a residual divergence, and the whole reason to
// build the field this way is to have none.

/** Rotate a gradient into the perpendicular, divergence-free direction. */
vec2 nzCurlOf(vec2 gradPsi) {
    return vec2(gradPsi.y, -gradPsi.x);
}

/**
 * Curl-noise velocity from an fbm potential.
 *
 * `octaves` buys structure at smaller scales; two or three is usually enough,
 * because a velocity field with too much fine detail integrates into a tangle
 * rather than into strands.
 */
vec2 nzCurl21(vec2 p, int octaves, float lacunarity, float gain) {
    return nzCurlOf(nzFbm21d(p, octaves, lacunarity, gain).yz);
}

vec2 nzCurl21(vec2 p, int octaves) {
    return nzCurl21(p, octaves, 2.0, 0.5);
}

vec2 nzCurl21s(vec2 p, int octaves, float lacunarity, float gain, int seed) {
    return nzCurlOf(nzFbm21ds(p, octaves, lacunarity, gain, seed).yz);
}
