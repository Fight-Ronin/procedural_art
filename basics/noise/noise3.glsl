#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"

// Gradient noise and fbm in three dimensions.
//
// Everything else in noise/ is 2D, which is enough for a field piece and not
// enough for anything marched: a surface found in 3D has to be textured and
// displaced in 3D. Texturing a marched surface with 2D noise means projecting,
// and a projection is visible the moment the surface turns away from it.
//
// NO ANALYTIC DERIVATIVE HERE, deliberately, even though noise/deriv.glsl has
// one for 2D. A displaced SDF gets its normal from `rmNormal`, which tetrahedron
// -taps `sceneSdf` and therefore already includes the displacement — the
// derivative would be a second, unused way to get the same vector. It arrives
// when a piece needs it, like everything else in basics/.

/**
 * A uniformly distributed direction on the sphere, from two hashes.
 *
 * z uniform on [-1,1] and the azimuth uniform is the correct construction:
 * naively normalising a random point in the cube clusters gradients towards the
 * eight corners, which shows up as a faint cubic anisotropy in the noise. And
 * as in the 2D version, it can never be normalize(vec3(0.0)) and spray NaN.
 */
vec3 nzGradVec3(vec3 lattice, int seed) {
    vec3 h = hash33(vec3(lattice) + float(seed) * 17.13);
    float z = h.x * 2.0 - 1.0;
    float a = h.y * TAU;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), r * sin(a), z);
}

/** Scale bringing the raw range (about +/-0.87 in 3D) to roughly [-1,1]. */
const float NZ_GRAD3_SCALE = 1.1547005;

/** Gradient noise in 3D. Eight corners, quintic interpolation. */
float nzGrad31s(vec3 p, int seed) {
    vec3 i = floor(p);
    vec3 f = p - i;
    vec3 u = quintic(f);

    float v000 = dot(nzGradVec3(i + vec3(0.0, 0.0, 0.0), seed), f - vec3(0.0, 0.0, 0.0));
    float v100 = dot(nzGradVec3(i + vec3(1.0, 0.0, 0.0), seed), f - vec3(1.0, 0.0, 0.0));
    float v010 = dot(nzGradVec3(i + vec3(0.0, 1.0, 0.0), seed), f - vec3(0.0, 1.0, 0.0));
    float v110 = dot(nzGradVec3(i + vec3(1.0, 1.0, 0.0), seed), f - vec3(1.0, 1.0, 0.0));
    float v001 = dot(nzGradVec3(i + vec3(0.0, 0.0, 1.0), seed), f - vec3(0.0, 0.0, 1.0));
    float v101 = dot(nzGradVec3(i + vec3(1.0, 0.0, 1.0), seed), f - vec3(1.0, 0.0, 1.0));
    float v011 = dot(nzGradVec3(i + vec3(0.0, 1.0, 1.0), seed), f - vec3(0.0, 1.0, 1.0));
    float v111 = dot(nzGradVec3(i + vec3(1.0, 1.0, 1.0), seed), f - vec3(1.0, 1.0, 1.0));

    return NZ_GRAD3_SCALE * mix(
        mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
        mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y),
        u.z);
}

float nzGrad31(vec3 p) { return nzGrad31s(p, 0); }

/**
 * Octave rotation in 3D.
 *
 * The 2D version rotates by an irrational-ish angle so successive lattices do
 * not stack into a plaid. The same problem is worse in 3D — three axis-aligned
 * lattices stacking give a visible cubic grain — so each octave is rotated
 * about an axis that is not aligned with any of them. The matrix is written out
 * rather than built with rot3() so it is a compile-time constant.
 */
const mat3 NZ_FBM3_ROT = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64);

float nzFbm31s(vec3 p, int octaves, float lacunarity, float gain, int seed) {
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        sum  += amp * nzGrad31s(p, seed + i);
        norm += amp;
        p = NZ_FBM3_ROT * p * lacunarity;
        amp *= gain;
    }
    return sum / max(norm, EPS);
}

float nzFbm31(vec3 p, int octaves, float lacunarity, float gain) {
    return nzFbm31s(p, octaves, lacunarity, gain, 0);
}

float nzFbm31(vec3 p, int octaves) { return nzFbm31(p, octaves, 2.0, 0.5); }

/**
 * Ridged 3D: sharp creases where the field crosses zero. The workhorse for
 * eroded rock, because erosion cuts channels rather than smoothing bumps.
 *
 * Returns roughly [0,1] rather than [-1,1] — it is a fold, so it has a floor.
 */
float nzRidged31(vec3 p, int octaves, float lacunarity, float gain) {
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    for (int i = 0; i < octaves; ++i) {
        sum  += amp * (1.0 - abs(nzGrad31(p)));
        norm += amp;
        p = NZ_FBM3_ROT * p * lacunarity;
        amp *= gain;
    }
    return sum / max(norm, EPS);
}
