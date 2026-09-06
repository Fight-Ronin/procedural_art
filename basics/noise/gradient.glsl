#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"

// Gradient (Perlin-style) noise. Random unit gradients per lattice point,
// quintic interpolation of their dot products. Zero at the lattice, so it
// looks smoother and less grid-aligned than value noise.
//
// Gradients come from an angle rather than normalize(hash * 2 - 1): a hash
// landing exactly on 0.5 would make that expression normalize(vec2(0.0)) and
// spray NaNs across the frame. Rare, driver-dependent, and miserable to track
// down — so it is designed out rather than clamped away.
//
// Range is approximately [-0.7, 0.7]; scaled here to fill roughly [-1, 1].

const float NZ_GRAD_SCALE = 1.4142135;

vec2 nzGradVec(vec2 lattice) {
    float a = hash21(lattice) * TAU;
    return vec2(cos(a), sin(a));
}

vec2 nzGradVecS(vec2 lattice, int seed) {
    float a = hash21s(lattice, seed) * TAU;
    return vec2(cos(a), sin(a));
}

float nzGrad21(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = quintic(f);

    float va = dot(nzGradVec(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float vb = dot(nzGradVec(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float vc = dot(nzGradVec(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float vd = dot(nzGradVec(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

    return NZ_GRAD_SCALE * mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

/** Seeded — same field shape, independent realisation. */
float nzGrad21s(vec2 p, int seed) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = quintic(f);

    float va = dot(nzGradVecS(i + vec2(0.0, 0.0), seed), f - vec2(0.0, 0.0));
    float vb = dot(nzGradVecS(i + vec2(1.0, 0.0), seed), f - vec2(1.0, 0.0));
    float vc = dot(nzGradVecS(i + vec2(0.0, 1.0), seed), f - vec2(0.0, 1.0));
    float vd = dot(nzGradVecS(i + vec2(1.0, 1.0), seed), f - vec2(1.0, 1.0));

    return NZ_GRAD_SCALE * mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}
