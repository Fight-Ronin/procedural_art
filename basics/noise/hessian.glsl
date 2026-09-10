#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"
#include "noise/gradient.glsl"
// The value and gradient here must agree with `noise/deriv.glsl` to the bit,
// so the constants and the lattice gradients have exactly one definition.
#include "noise/deriv.glsl"
#include "noise/fbm.glsl"

// Gradient noise and fbm that return their ANALYTIC SECOND derivative — the
// Hessian — alongside the value and gradient.
//
// This exists for one thing: a caustic. Light through a phase screen lands at
//
//     x(u) = u - a * grad(phi)(u)
//
// so the map's Jacobian is `I - a * Hess(phi)`, and the caustic — the bright
// network — is exactly the zero set of its determinant. The picture IS the
// second derivative; there is no other quantity in it.
//
// Why analytic rather than differenced, for the second time in this library
// and for a sharper reason than the first. `noise/deriv.glsl` argues cost and
// exactness for the gradient. Here exactness is the entire subject: the caustic
// is a ZERO SET, and a zero set is where a small error in the field becomes a
// large error in position. Near a fold the determinant crosses zero with some
// slope s, so an error e in the Hessian displaces the caustic line by e/s —
// unbounded as the fold flattens, which is precisely where cusps live and where
// the interesting structure is. Central differences of the gradient would put a
// truncation term with the wrong sign structure into the very quantity whose
// sign draws the picture, and the result would be a plausible caustic network
// that is not the caustic network of this field.
//
// Cost is the ordinary argument as well: differencing the analytic gradient
// costs four extra fbm evaluations per sample against one here.
//
// The Hessian of an interpolant is easier to get subtly wrong than its
// gradient, and every wrong version still draws a convincing caustic — which is
// why `test/noise.test.ts` checks these by convergence against differences of
// the analytic gradient rather than by looking at them.

/**
 * Gradient noise with its gradient and Hessian.
 *
 * Returns vec3(value, d/dx, d/dy); the symmetric Hessian comes back in `h`.
 * The value and gradient are the same expressions in the same order as
 * `nzGrad21ds` and `nzGrad21ds`'s derivative in `noise/deriv.glsl`, so a shader
 * may mix the two freely.
 *
 * Writing out the algebra: with n = va + ux k0 + uy k1 + ux uy k2, where the
 * ks are differences of the four corner dot products and ux, uy the quintic
 * weights, the gradient has a LATTICE part (the corner gradients carried
 * through the blend) and a WEIGHT part (the blend weights themselves moving).
 * Differentiating a second time hits both, and the three terms below are, in
 * order: the weight part differentiating the lattice part, the lattice part
 * differentiating the weight part — these two are equal and so appear as a
 * factor of two on the diagonal — and the weight derivative differentiating
 * itself.
 *
 * The mixed term is the one to watch. `du.x * du.y * k2` comes only from the
 * bilinear corner k2 and vanishes for any field whose corners happen to be
 * separable; drop it and the Hessian is right on axis-aligned test data and
 * wrong everywhere else.
 */
vec3 nzGrad21dds(vec2 p, int seed, out mat2 h) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u   = quintic(f);
    vec2 du  = quinticD(f);
    vec2 ddu = quinticDD(f);

    vec2 ga = nzGradVecS(i + vec2(0.0, 0.0), seed);
    vec2 gb = nzGradVecS(i + vec2(1.0, 0.0), seed);
    vec2 gc = nzGradVecS(i + vec2(0.0, 1.0), seed);
    vec2 gd = nzGradVecS(i + vec2(1.0, 1.0), seed);

    float va = dot(ga, f - vec2(0.0, 0.0));
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));

    // The blend coefficients and their gradients. The gradients are CONSTANT
    // within a cell, which is what keeps the second derivative finite.
    float k0 = vb - va;              vec2 dk0 = gb - ga;
    float k1 = vc - va;              vec2 dk1 = gc - ga;
    float k2 = va - vb - vc + vd;    vec2 dk2 = ga - gb - gc + gd;

    float n = va + u.x * k0 + u.y * k1 + u.x * u.y * k2;

    vec2 lat = ga + u.x * dk0 + u.y * dk1 + u.x * u.y * dk2;
    vec2 m   = vec2(k0 + u.y * k2, k1 + u.x * k2);
    vec2 grad = lat + du * m;

    float hxx = 2.0 * du.x * (dk0.x + u.y * dk2.x) + ddu.x * m.x;
    float hyy = 2.0 * du.y * (dk1.y + u.x * dk2.y) + ddu.y * m.y;
    float hxy = du.x * (dk0.y + u.y * dk2.y)
              + du.y * (dk1.x + u.x * dk2.x)
              + du.x * du.y * k2;

    h = NZ_GRAD_SCALE * mat2(hxx, hxy, hxy, hyy);
    return NZ_GRAD_SCALE * vec3(n, grad);
}

/**
 * Unseeded twin. NOT `nzGrad21dds(..., 0)`, for the reason `noise/deriv.glsl`
 * gives: the seeded and unseeded lattice gradients come from different hashes,
 * so delegating would return the curvature of a different field than
 * `nzGrad21` evaluates.
 */
vec3 nzGrad21dd(vec2 p, out mat2 h) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u   = quintic(f);
    vec2 du  = quinticD(f);
    vec2 ddu = quinticDD(f);

    vec2 ga = nzGradVec(i + vec2(0.0, 0.0));
    vec2 gb = nzGradVec(i + vec2(1.0, 0.0));
    vec2 gc = nzGradVec(i + vec2(0.0, 1.0));
    vec2 gd = nzGradVec(i + vec2(1.0, 1.0));

    float va = dot(ga, f - vec2(0.0, 0.0));
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));

    float k0 = vb - va;              vec2 dk0 = gb - ga;
    float k1 = vc - va;              vec2 dk1 = gc - ga;
    float k2 = va - vb - vc + vd;    vec2 dk2 = ga - gb - gc + gd;

    float n = va + u.x * k0 + u.y * k1 + u.x * u.y * k2;

    vec2 lat = ga + u.x * dk0 + u.y * dk1 + u.x * u.y * dk2;
    vec2 m   = vec2(k0 + u.y * k2, k1 + u.x * k2);
    vec2 grad = lat + du * m;

    float hxx = 2.0 * du.x * (dk0.x + u.y * dk2.x) + ddu.x * m.x;
    float hyy = 2.0 * du.y * (dk1.y + u.x * dk2.y) + ddu.y * m.y;
    float hxy = du.x * (dk0.y + u.y * dk2.y)
              + du.y * (dk1.x + u.x * dk2.x)
              + du.x * du.y * k2;

    h = NZ_GRAD_SCALE * mat2(hxx, hxy, hxy, hyy);
    return NZ_GRAD_SCALE * vec3(n, grad);
}

/**
 * fbm with its gradient and Hessian.
 *
 * THE CHAIN RULE, ONE ORDER UP FROM `noise/deriv.glsl`. Octave i is evaluated
 * at M p with M = (lacunarity * rot)^i, so
 *
 *     grad  <- M^T g
 *     Hess  <- M^T H M
 *
 * and neither `M H M^T` nor a bare `H` is close enough to be caught by eye. All
 * three give a curvature field with the right magnitude and the right texture;
 * they differ by a rotation that GROWS with the octave index, so the low
 * octaves — which carry most of the amplitude — agree and only the fine detail
 * is turned. In a caustic that means the large folds land in the right place
 * and the small ones do not, which looks exactly like a caustic.
 *
 * The value and gradient match `nzFbm21ds` to within float rounding rather
 * than to the bit, for the same reason `nzFbm21ds`'s derivative does: this
 * accumulates the transform as a matrix while `nzFbm21s` walks the point
 * forward one octave at a time.
 */
vec3 nzFbm21dds(vec2 p, int octaves, float lacunarity, float gain, int seed, out mat2 h) {
    mat2 rot = rot2(NZ_FBM_ROT);
    mat2 m = mat2(1.0);            // (lacunarity * rot)^i, accumulated
    float sum = 0.0;
    vec2 dsum = vec2(0.0);
    mat2 hsum = mat2(0.0);
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        mat2 hi;
        vec3 nd = nzGrad21dds(m * p, seed + i, hi);
        sum  += amp * nd.x;
        dsum += amp * (transpose(m) * nd.yz);
        hsum += amp * (transpose(m) * hi * m);
        norm += amp;
        m = lacunarity * rot * m;
        amp *= gain;
    }
    h = hsum / max(norm, EPS);
    return vec3(sum, dsum) / max(norm, EPS);
}

/** Unseeded twin, on the unseeded lattice — see `nzGrad21dd`. */
vec3 nzFbm21dd(vec2 p, int octaves, float lacunarity, float gain, out mat2 h) {
    mat2 rot = rot2(NZ_FBM_ROT);
    mat2 m = mat2(1.0);
    float sum = 0.0;
    vec2 dsum = vec2(0.0);
    mat2 hsum = mat2(0.0);
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        mat2 hi;
        vec3 nd = nzGrad21dd(m * p, hi);
        sum  += amp * nd.x;
        dsum += amp * (transpose(m) * nd.yz);
        hsum += amp * (transpose(m) * hi * m);
        norm += amp;
        m = lacunarity * rot * m;
        amp *= gain;
    }
    h = hsum / max(norm, EPS);
    return vec3(sum, dsum) / max(norm, EPS);
}
