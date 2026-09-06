#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"
#include "noise/gradient.glsl"
// For FBM_ROT: the derivative has to walk the octaves through the SAME rotation
// the value does, so the constant has exactly one definition.
#include "noise/fbm.glsl"

// Gradient noise and fbm that return their ANALYTIC derivative alongside the
// value: vec3(value, d/dx, d/dy).
//
// Two reasons this is worth the algebra rather than taking finite differences.
//
// Cost. A curl-noise flow field needs the gradient of an fbm potential at every
// integration step. Central differences would cost four extra fbm evaluations
// per step; at four octaves and thirty steps that is four hundred and eighty
// noise evaluations per sample instead of a hundred and twenty.
//
// Exactness. The point of building a velocity field as the curl of a potential
// is that it is divergence-free — nothing is created or destroyed, which is
// what makes flow imagery look like a fluid rather than like noise. That
// property comes from the mixed partials of the potential cancelling, and they
// cancel EXACTLY only if the two derivatives are exact. Finite differences
// leave a residual divergence that shows up as density quietly pooling and
// thinning where nothing should be pooling or thinning.
//
// The derivative of a function that interpolates is easy to get subtly wrong —
// a sign, a transposed matrix, a missing lacunarity factor — and every one of
// those still produces a plausible picture. `test/noise.test.ts` therefore
// checks these against central differences on the real driver.

/**
 * Value and gradient of quintic smoothstep. The interpolant's own derivative is
 * needed because the lattice values are themselves being blended by it.
 */
vec2 quinticD(vec2 t) {
    return 30.0 * t * t * (t * (t - 2.0) + 1.0);
}

/**
 * Gradient noise with its derivative. Same field as `nzGrad21`, to the bit —
 * the value half is the identical expression on the identical inputs.
 *
 * n = va + u.x (vb - va) + u.y (vc - va) + u.x u.y (va - vb - vc + vd)
 *
 * Differentiating that has two parts: the lattice gradients carried through the
 * blend, and the blend weights themselves changing. Both are below; dropping
 * the second is the classic mistake and gives a derivative that is right only
 * at the lattice points.
 */
vec3 nzGrad21d(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = quintic(f);
    vec2 du = quinticD(f);

    vec2 ga = nzGradVec(i + vec2(0.0, 0.0));
    vec2 gb = nzGradVec(i + vec2(1.0, 0.0));
    vec2 gc = nzGradVec(i + vec2(0.0, 1.0));
    vec2 gd = nzGradVec(i + vec2(1.0, 1.0));

    float va = dot(ga, f - vec2(0.0, 0.0));
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));

    float k0 = vb - va;
    float k1 = vc - va;
    float k2 = va - vb - vc + vd;

    float n = va + u.x * k0 + u.y * k1 + u.x * u.y * k2;

    vec2 grad =
        ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
        + du * vec2(k0 + u.y * k2, k1 + u.x * k2);

    return NZ_GRAD_SCALE * vec3(n, grad);
}

/** Seeded twin of `nzGrad21d`; same field as `nzGrad21s`, to the bit. */
vec3 nzGrad21ds(vec2 p, int seed) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = quintic(f);
    vec2 du = quinticD(f);

    vec2 ga = nzGradVecS(i + vec2(0.0, 0.0), seed);
    vec2 gb = nzGradVecS(i + vec2(1.0, 0.0), seed);
    vec2 gc = nzGradVecS(i + vec2(0.0, 1.0), seed);
    vec2 gd = nzGradVecS(i + vec2(1.0, 1.0), seed);

    float va = dot(ga, f - vec2(0.0, 0.0));
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));

    float k0 = vb - va;
    float k1 = vc - va;
    float k2 = va - vb - vc + vd;

    float n = va + u.x * k0 + u.y * k1 + u.x * u.y * k2;

    vec2 grad =
        ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
        + du * vec2(k0 + u.y * k2, k1 + u.x * k2);

    return NZ_GRAD_SCALE * vec3(n, grad);
}

/**
 * fbm with its derivative. The same field as `nzFbm21s` — but to within float
 * rounding, not to the bit: `nzFbm21s` walks the point forward one octave at a
 * time while this accumulates the transform as a matrix, and those two orders
 * of multiplication do not agree in the last bits. The difference is around
 * 1e-6 and irrelevant to a picture; it is stated because "identical" and
 * "identical to a millionth" are different promises.
 *
 * Octave i is evaluated at M p, where M = (lacunarity * rot)^i. The chain rule
 * therefore wants M TRANSPOSED applied to that octave's gradient — not M, and
 * not the un-accumulated rotation. Getting this wrong rotates the whole
 * gradient field by a growing angle, which for a flow field means streamlines
 * that curl the wrong way while still looking like streamlines.
 */
vec3 nzFbm21ds(vec2 p, int octaves, float lacunarity, float gain, int seed) {
    mat2 rot = rot2(FBM_ROT);
    mat2 m = mat2(1.0);            // (lacunarity * rot)^i, accumulated
    float sum = 0.0;
    vec2 dsum = vec2(0.0);
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        vec3 nd = nzGrad21ds(m * p, seed + i);
        sum  += amp * nd.x;
        dsum += amp * (transpose(m) * nd.yz);
        norm += amp;
        m = lacunarity * rot * m;
        amp *= gain;
    }
    return vec3(sum, dsum) / max(norm, EPS);
}

/**
 * Unseeded twin. NOT `nzFbm21ds(..., 0)`: the seeded and unseeded lattice
 * gradients come from different hashes (`hash21s(l, 0)` is not `hash21(l)`), so
 * delegating would return a derivative of a different field than `nzFbm21`
 * evaluates — correct-looking, and wrong for anyone who mixes the two.
 */
vec3 nzFbm21d(vec2 p, int octaves, float lacunarity, float gain) {
    mat2 rot = rot2(FBM_ROT);
    mat2 m = mat2(1.0);
    float sum = 0.0;
    vec2 dsum = vec2(0.0);
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        vec3 nd = nzGrad21d(m * p);
        sum  += amp * nd.x;
        dsum += amp * (transpose(m) * nd.yz);
        norm += amp;
        m = lacunarity * rot * m;
        amp *= gain;
    }
    return vec3(sum, dsum) / max(norm, EPS);
}
