#pragma once
#include "core/math.glsl"
#include "noise/gradient.glsl"
#include "noise/value.glsl"

// Fractional Brownian motion: sum octaves of noise at rising frequency and
// falling amplitude.
//
// Each octave is rotated by an irrational-ish angle before scaling. Without
// this, the lattices of successive octaves stay axis-aligned and stack into a
// visible plaid — the single most common tell of amateur fbm.

const float NZ_FBM_ROT = 0.7853981; // ~pi/4, coprime enough with the lattice

float nzFbm21(vec2 p, int octaves, float lacunarity, float gain) {
    mat2 rot = rot2(NZ_FBM_ROT);
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        sum  += amp * nzGrad21(p);
        norm += amp;
        p = rot * p * lacunarity;
        amp *= gain;
    }
    return sum / max(norm, EPS);
}

float nzFbm21(vec2 p, int octaves) {
    return nzFbm21(p, octaves, 2.0, 0.5);
}

float nzFbm21s(vec2 p, int octaves, float lacunarity, float gain, int seed) {
    mat2 rot = rot2(NZ_FBM_ROT);
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        sum  += amp * nzGrad21s(p, seed + i);
        norm += amp;
        p = rot * p * lacunarity;
        amp *= gain;
    }
    return sum / max(norm, EPS);
}

/** Ridged variant: sharp creases where the field crosses zero. */
float nzRidged21(vec2 p, int octaves, float lacunarity, float gain) {
    mat2 rot = rot2(NZ_FBM_ROT);
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        sum  += amp * (1.0 - abs(nzGrad21(p)));
        norm += amp;
        p = rot * p * lacunarity;
        amp *= gain;
    }
    return sum / max(norm, EPS);
}

/**
 * Domain warping (IQ), with each stage's lattice free to move on its own.
 *
 * `ow` displaces the first warp field, `ov` the second, `os` the field being
 * sampled through them. Zero for all three is plain domain warping.
 *
 * WHY THE THREE OFFSETS ARE SEPARATE. Give all three the SAME offset c and the
 * result is exactly the un-offset warp evaluated at p + c: every stage sees its
 * own argument shifted by c, so the composite is a function of p only through
 * p + c. That is a rigid translation of the whole picture and nothing else —
 * which is why animating a single offset pans a warped field rather than making
 * it flow, however the offset moves. Different offsets are not a translation of
 * anything: the stages slide past one another and the composite deforms in
 * place, features stretching, splitting and re-forming without going anywhere.
 * 001 measured this both ways; the note is in claude/001-flowing.md.
 *
 * `q` and `r` come back so the artwork can colour by the intermediate
 * displacement fields, which is where the good structure is.
 */
float nzWarp21(vec2 p, int octaves, float amount, vec2 ow, vec2 ov, vec2 os,
               out vec2 q, out vec2 r) {
    q = vec2(nzFbm21(p + ow, octaves), nzFbm21(p + ow + vec2(5.2, 1.3), octaves));
    r = vec2(nzFbm21(p + amount * q + ov + vec2(1.7, 9.2), octaves),
             nzFbm21(p + amount * q + ov + vec2(8.3, 2.8), octaves));
    return nzFbm21(p + amount * r + os, octaves);
}

float nzWarp21(vec2 p, int octaves, float amount, out vec2 q, out vec2 r) {
    return nzWarp21(p, octaves, amount, vec2(0.0), vec2(0.0), vec2(0.0), q, r);
}
