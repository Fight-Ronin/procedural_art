#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"

// A directional gravity-wave surface, with its gradient and Hessian in closed
// form.
//
// WHY THIS AND NOT fbm. 013 built its water out of fbm, and the picture was a
// convincing caustic that did not look like water. Two things were missing and
// they turn out to be the same thing.
//
// A wind-driven water surface is not a random landscape; it is a SUM OF
// TRAVELLING WAVES, each with its own direction, and each moving at a speed set
// by its own wavelength:
//
//     omega(k) = sqrt(g k)          deep-water gravity waves
//
// That relation is the whole character of water. Long swells outrun short chop,
// so the crests continually overtake one another: the pattern reorganises
// instead of sliding. Anyone who has watched a pool floor knows the caustic net
// does not drift across the tiles, it BREATHES — cells merge, split and reform
// in place.
//
// And it is also the answer to the other question. 001 established that pushing
// a composed field through one moving offset can only ever translate it, which
// is an identity, not a tuning problem. A DISPERSIVE sum escapes that by
// construction: if two components move at different speeds there is no single
// offset that carries the sum, so "flowing" is guaranteed by the physics rather
// than arranged by hand. Set every omega equal and the same code becomes a pure
// pan — which is what `test/wave.test.ts` uses as its control.
//
// THE DERIVATIVES ARE EXACT AND FREE. A caustic is the zero set of
// det(I - a Hess), so `noise/hessian.glsl` had to work hard for an fbm's second
// derivative. For a sum of sinusoids there is nothing to derive:
//
//     phi  =  sum A sin(K.p - omega t + psi)
//     grad =  sum A K cos(K.p - omega t + psi)
//     Hess = -sum A (K (x) K) sin(K.p - omega t + psi)
//
// Every component's Hessian is RANK ONE — a single wave is a cylindrical lens,
// so it focuses in one direction and not at all in the other, and its
// determinant is exactly zero. The interesting curvature is entirely in how the
// components add up, which is why a narrow-band swell gives long parallel
// caustic lines and a broad one gives the polygonal net.

/** Deep-water dispersion. `speed` carries g and the choice of units. */
float flowWaveOmega(float k, float speed) {
    return speed * sqrt(k);
}

/** A surface height with everything the lens map needs. */
struct FlowWaveSurface {
    float h;
    vec2  grad;
    mat2  hess;
};

/**
 * `n` gravity waves on a geometric ladder of wavenumbers.
 *
 * `k0`     wavenumber of the longest component; the composition's scale.
 * `ratio`  geometric step between components. Deliberately not 2: an integer
 *          ratio makes every component's crests commensurate with the longest
 *          one, and the sum then repeats on the long wave's period — visible as
 *          a tiling with the swell's spacing. An irrational-ish step avoids it
 *          for the same reason `NZ_FBM_ROT` is not a right angle.
 * `steep`  steepness A*k of the longest wave. Steepness rather than amplitude
 *          because it is the dimensionless quantity that decides how the
 *          surface LOOKS: the slope, and hence the deflection, and hence the
 *          caustic. Real gravity waves break near 0.44; well below that is a
 *          calm swell and near it is chop.
 * `tail`   how steepness falls with wavenumber, s_i = steep * (k_i/k0)^-tail.
 *          0 is self-similar — every scale equally steep, which reads as a
 *          rough, wind-blown surface. Larger values calm the short waves and
 *          leave a smooth swell.
 * `dir`    mean travel direction in radians, `spread` the half-angle around it.
 *          A narrow spread is swell arriving from one quarter and gives long
 *          parallel caustics; a full spread is a confused sea and gives the
 *          polygonal net.
 * `speed`  scales omega, so it is a time rate and nothing else. Zero freezes
 *          the surface without changing its shape, which is what makes a still
 *          and a frame of the sequence the same picture.
 *
 * Components are laid out from a hash of the index and `seed`, so the surface
 * is a pure function of its arguments and reproducible forever.
 */
FlowWaveSurface flowWaveGravity(vec2 p, float t, int n, float k0, float ratio,
                        float steep, float tail, float dir, float spread,
                        float speed, int seed) {
    FlowWaveSurface s;
    s.h = 0.0;
    s.grad = vec2(0.0);
    s.hess = mat2(0.0);

    float k = k0;
    for (int i = 0; i < 32; ++i) {
        if (i >= n) break;

        // Three independent draws per component. The angle is spread with a
        // cubic ease rather than uniformly, so most of the energy sits near the
        // mean direction and the flanks are thin — which is what a wind sea
        // does, and what keeps a wide spread from turning into visual mush.
        vec3 r = vec3(hash21s(vec2(float(i), 0.0), seed),
                      hash21s(vec2(float(i), 1.0), seed),
                      hash21s(vec2(float(i), 2.0), seed));
        float e = r.x * 2.0 - 1.0;
        float ang = dir + spread * e * e * e;
        vec2 d = vec2(cos(ang), sin(ang));

        // Steepness, not amplitude — see the header.
        float sK = steep * safePow(k / k0, -tail);
        float amp = sK / k;

        vec2 K = k * d;
        float ph = dot(K, p) - flowWaveOmega(k, speed) * t + r.y * TAU;
        float sn = sin(ph);
        float cs = cos(ph);

        s.h    += amp * sn;
        s.grad += amp * cs * K;
        // Rank one, and exactly so: outer(K, K) has zero determinant, which is
        // the statement that one wave is a cylindrical lens.
        s.hess -= amp * sn * mat2(K.x * K.x, K.x * K.y, K.x * K.y, K.y * K.y);

        // r.z jitters the ladder so the wavenumbers are not exactly geometric;
        // without it, components at ratio^i share more structure than they
        // should and the sum looks periodic on the long wave.
        k *= ratio * (0.9 + 0.2 * r.z);
    }
    return s;
}
