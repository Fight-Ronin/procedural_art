#pragma once
#include "core/math.glsl"

/**
 * Iterated wave folding: a domain warp made of cross-coupled sinusoids.
 *
 * This is the operator behind a whole family of shaders that look like smoke,
 * plasma or nebula filaments, and it is NOT the fbm domain warp already in this
 * library. The difference is worth stating precisely, because the two are
 * easily mistaken for each other and they do not look alike:
 *
 *   fbm warp   — displaces p by band-limited LATTICE noise. Statistically
 *                isotropic, no preferred direction, and the result reads as
 *                cloud: blobby, rounded, the same in every orientation.
 *
 *   wave fold  — displaces each axis by cosines of the OTHER TWO axes
 *                (the .yzx swizzle). That cross-coupling is a shear, so
 *                iterating it winds material around itself and the result
 *                reads as filament: long, silky, directional strands.
 *
 * Take the swizzle out and the warp becomes separable — each axis displaced by
 * a function of itself alone — and it degenerates into axis-aligned ripples
 * with no swirl at all. `test/fold.test.ts` uses exactly that as its control,
 * because it is the one change that looks like a typo and destroys the effect.
 *
 * WHY IT FOLDS RATHER THAN MERELY RIPPLES. Octave i contributes amplitude
 * gain^i at frequency lacunarity^i, so its contribution to the DISPLACEMENT is
 * gain^i (a convergent sum) but its contribution to the JACOBIAN is
 * (gain * lacunarity)^i. At the classic pairing — gain 0.7 with lacunarity
 * 1/0.7 — that product is exactly 1, so every octave perturbs the derivative
 * equally no matter how many you add. The map is therefore not a contraction:
 * it can and does fold space over itself, which is where the filaments come
 * from. Raising gain * lacunarity above 1 makes it fold harder and eventually
 * into noise; below 1 it flattens toward a smooth swirl.
 *
 * The displacement is bounded, which is what makes it safe to use inside a
 * bounded marching volume: each component moves by at most
 * `(1 - gain^octaves) / (1 - gain)`, and the caller can rely on that when
 * sizing the bound. Pure, continuous and infinitely differentiable — there is
 * no lattice and no hash anywhere in it.
 *
 * Not volume-preserving. `noise/curl.glsl` is the operator to reach for when
 * nothing may pile up; this one piles material into the folds on purpose.
 */

/** Loop bound. GLSL ES 3.0 wants a constant trip count for unrolling. */
const int NZ_FOLD_MAX = 12;

/**
 * Warp `p` by `octaves` folds. `lacunarity` is the frequency step, `gain` the
 * amplitude step; `gain * lacunarity` near 1 is the interesting regime.
 */
vec3 nzFold3(vec3 p, int octaves, float lacunarity, float gain, float amplitude) {
    float f = 1.0;
    float a = amplitude;
    for (int i = 0; i < NZ_FOLD_MAX; ++i) {
        if (i >= octaves) break;
        p += cos(p.yzx * f) * a;
        f *= lacunarity;
        a *= gain;
    }
    return p;
}

/**
 * Unit amplitude.
 *
 * Amplitude is a separate knob from gain because they do different things and
 * the difference is the whole control surface of this operator: gain sets how
 * the octaves are BALANCED against each other (and with lacunarity, whether the
 * map folds at all), amplitude scales the lot. Turning gain up to get more
 * violence also buries the large-scale structure under the fine octaves, which
 * is how a nebula turns into static.
 */
vec3 nzFold3(vec3 p, int octaves, float lacunarity, float gain) {
    return nzFold3(p, octaves, lacunarity, gain, 1.0);
}

/** The classic pairing: gain * lacunarity == 1, the borderline folding case. */
vec3 nzFold3(vec3 p, int octaves) {
    return nzFold3(p, octaves, 1.0 / 0.7, 0.7);
}

/**
 * The bound on how far `nzFold3` can move a point, per component.
 *
 * Exposed rather than left implicit because a volume piece has to size its
 * bounding sphere around the WARPED extent, and getting that wrong clips the
 * outer filaments against an invisible sphere — which reads as a strangely
 * circular edge to the nebula and is very hard to attribute.
 */
float nzFoldBound(int octaves, float gain, float amplitude) {
    return amplitude * (abs(gain - 1.0) < 1.0e-6
        ? float(octaves)
        : (1.0 - pow(gain, float(octaves))) / (1.0 - gain));
}

float nzFoldBound(int octaves, float gain) { return nzFoldBound(octaves, gain, 1.0); }

/**
 * 2D wave fold. Same idea with the only cross-coupling two axes allow: each
 * component displaced by a cosine of the other.
 */
vec2 nzFold2(vec2 p, int octaves, float lacunarity, float gain) {
    float f = 1.0;
    float a = 1.0;
    for (int i = 0; i < NZ_FOLD_MAX; ++i) {
        if (i >= octaves) break;
        p += cos(p.yx * f) * a;
        f *= lacunarity;
        a *= gain;
    }
    return p;
}
