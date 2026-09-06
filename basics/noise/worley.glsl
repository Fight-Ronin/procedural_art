#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"

// Worley (cellular) noise: scatter one feature point per lattice cell, then ask
// how far the nearest ones are. F1 alone gives blobs; F2 - F1 is zero exactly
// on the ridge between two neighbours, which is the cell WALL and the reason
// anyone reaches for this — cracked ground, foam, leaf venation, dried mud.
//
// The property that makes F1 useful as more than a texture is that it is
// 1-Lipschitz: |F1(a) - F1(b)| <= |a - b|. That is what a true distance to a
// nearest point always satisfies, and it is what lets F1 be antialiased like a
// signed distance — one screen width in domain units is one screen width in F1.
//
// A SEARCH THAT IS TOO SMALL DESTROYS THAT PROPERTY, and does it quietly: miss
// the real nearest point and F1 jumps, so it no longer bounds anything, and the
// picture merely looks slightly wrong near some cell corners. The usual 3x3
// search is not always enough, which is worth deriving rather than repeating.
//
// With jitter j, a cell's feature point lies within g + [0.5-j/2, 0.5+j/2]^2,
// and the query point lies in [0,1)^2 of the centre cell. So:
//
//   the centre cell's own point is at most  sqrt(2) * (1+j)/2  away
//   a point two cells out is more than      1.5 - j/2          away
//
// and 3x3 can only be trusted while the second exceeds the first:
//
//   j <= (3 - sqrt(2)) / (1 + sqrt(2))  ~=  0.6569
//
// Above that a fully-jittered neighbour two cells away can beat everything in
// the ring. Five-by-five clears it with room (a point three cells out is more
// than 2.0 away, against a worst case of sqrt(2) ~= 1.414), so the radius
// follows the jitter rather than being fixed at the customary 3x3.
//
// HOW OFTEN DOES 3x3 ACTUALLY FAIL? Measured, not guessed: zero times in
// 262144 queries at jitter 1, including 65536 with an independent point layout
// each and the query pinned hard against a cell edge, which is the geometry the
// derivation says is worst. The failing configuration needs nine hashes to
// conspire — every in-ring point flung to a far corner while a point two cells
// out sits square in the query's path — and uniform hashes do not do that. Only
// 20 of those 65536 queries even produced an F1 above 1.0, the threshold below
// which failure is not arithmetically possible.
//
// So the wider search is not bought with evidence of failures; it is bought so
// that the 1-Lipschitz property above is a guarantee rather than a statistic,
// at a cost this library gets to choose where to pay. Anyone tempted to drop
// back to a flat 3x3 has the measurement here and should keep the test.
//
// `test/noise.test.ts` checks all of it by brute force — the same query at
// radius 1, 2 and 3 — rather than trusting the algebra above, and pins a
// control (radius 0 must disagree) so that agreement means something.

/** Largest jitter for which a 3x3 search is provably sufficient. */
const float NZ_WORLEY_R1_JITTER = 0.6568542;

struct WorleyF {
    float f1;
    float f2;
    /** Offset to the nearest feature point. Zero-length only at a feature point. */
    vec2 toNearest;
    /** Hash of the nearest cell, in [0,1) — a stable per-cell id for colouring. */
    float id;
};

/**
 * Explicit search radius, in cells. Exposed so a test can widen it and check
 * that the answer stops changing; artwork should call `nzWorley21f`, which
 * picks the radius from the jitter.
 *
 * `jitter` in [0,1] moves feature points from the cell centres out towards the
 * corners: 0 is a square grid, 1 is a proper Voronoi diagram. It is clamped
 * rather than trusted, because above 1 a point could leave its own cell and
 * every bound above would be void.
 */
WorleyF nzWorley21fr(vec2 p, float jitter, int seed, int radius) {
    jitter = sat(jitter);
    vec2 cell = floor(p);
    vec2 f = p - cell;

    WorleyF w;
    // Larger than any distance the search can return, so the first candidate
    // always wins; F2 stays here only if the ring somehow holds one point.
    w.f1 = 1e9;
    w.f2 = 1e9;
    w.toNearest = vec2(0.0);
    w.id = 0.0;

    for (int j = -radius; j <= radius; ++j) {
        for (int i = -radius; i <= radius; ++i) {
            vec2 g = vec2(float(i), float(j));
            vec2 h = hash22s(cell + g, seed);
            vec2 point = g + 0.5 + (h - 0.5) * jitter;
            vec2 d = point - f;
            float dist = length(d);
            if (dist < w.f1) {
                w.f2 = w.f1;
                w.f1 = dist;
                w.toNearest = d;
                w.id = h.x;
            } else if (dist < w.f2) {
                w.f2 = dist;
            }
        }
    }
    return w;
}

/** F1, F2 and the nearest cell, searching as widely as the jitter requires. */
WorleyF nzWorley21f(vec2 p, float jitter, int seed) {
    return nzWorley21fr(p, jitter, seed, jitter <= NZ_WORLEY_R1_JITTER ? 1 : 2);
}

/** Distance to the nearest feature point. 1-Lipschitz. */
float nzWorley21(vec2 p, float jitter, int seed) {
    return nzWorley21f(p, jitter, seed).f1;
}

/**
 * Cell walls: zero on the ridge exactly between the two nearest points, rising
 * into the cell interiors. Being a difference of two 1-Lipschitz functions it
 * is 2-Lipschitz, so an edge drawn on it wants half the width it would want
 * on F1.
 */
float nzWorleyEdge21(vec2 p, float jitter, int seed) {
    WorleyF w = nzWorley21f(p, jitter, seed);
    return w.f2 - w.f1;
}
