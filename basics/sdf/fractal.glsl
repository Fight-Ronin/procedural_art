#pragma once
#include "core/math.glsl"

/**
 * Distance ESTIMATORS for shapes defined by an iterated map.
 *
 * Everything else in `sdf/` is an exact signed distance: `sdBox` returns the
 * true distance to a box and `test/sdf.test.ts` holds it to 1e-5. Nothing here
 * does. These shapes have no closed form — they are the fixed point of a fold,
 * and what an estimator returns is a CONSERVATIVE LOWER BOUND on the distance
 * to that fixed point, recovered from how much the map stretched space on the
 * way in.
 *
 * That difference is not academic, and it is why these live in their own file
 * rather than beside the exact primitives:
 *
 *   - A marcher can step by an estimate safely (that is the whole contract:
 *     never overshoot) but a piece cannot use one as a thickness, a falloff
 *     width, or an antialiasing footprint. `aa/edge.glsl` assumes |grad| = 1,
 *     which is exactly what an estimator does not give you.
 *   - The bound gets looser the closer you are, so a marcher creeps near the
 *     surface and needs an iteration cap rather than a pure distance test.
 *   - "Exact" tests do not apply. `test/fractal.test.ts` checks the property
 *     that actually matters — that a step of length DE(p) never passes through
 *     the surface — rather than comparing against a truth it cannot compute.
 *
 * The scale accumulator is the mechanism in one line: each iteration multiplies
 * space by a known factor, so a distance measured in the folded frame is
 * divided by the product of those factors to come back to the original one.
 */

/** Iteration cap. GLSL ES 3.0 wants a constant trip count. */
const int SD_FRACTAL_MAX = 16;

/**
 * Apollonian gasket: spheres packed into the gaps between spheres, forever.
 *
 * Two operations, iterated. `fract` folds space into a unit cell, which is what
 * makes the packing repeat; the inversion `p / dot(p,p)` turns the inside of
 * the unit sphere out, which is what makes each gap contain a smaller copy of
 * the whole arrangement. Neither alone does anything interesting — the fold
 * without the inversion is a grid, and the inversion without the fold is one
 * sphere turned inside out. `test/fractal.test.ts` uses both halves as
 * controls, because it is precisely their composition that is the shape.
 *
 * `s` sets how much the inversion scales on each pass and therefore how tightly
 * the packing nests. Values near 1 give sparse, well separated spheres; higher
 * values pack harder and eventually turn the whole thing to foam.
 */
float sdApollonian(vec3 p, float s, int iters) {
    float scale = 1.0;
    for (int i = 0; i < SD_FRACTAL_MAX; ++i) {
        if (i >= iters) break;
        // Fold into [-1, 1] about the cell centre. Written as fract rather
        // than as a mod-and-shift because fract is exact at the cell boundary
        // on every driver tested, and a half-texel disagreement there shows up
        // as a seam running through the packing.
        p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
        float r2 = dot(p, p);
        // The inversion. Clamped away from the origin: r2 -> 0 sends k to
        // infinity, and one infinity in the scale accumulator poisons the
        // distance for that whole ray rather than for one iteration.
        float k = s / max(r2, 1.0e-6);
        p *= k;
        scale *= k;
    }
    // Distance to a PLANE in the folded frame, divided back out by the total
    // stretch.
    //
    // The axis-aligned choice inside an otherwise isotropic construction looks
    // like a mistake and is not: it is what makes this an Apollonian gasket.
    // Swapping it for the isotropic `length(p) - 1` was tried and produces a
    // completely different shape — nested shells, no packing at all. The cost
    // of keeping it is that the y = 0 plane survives wherever the fold barely
    // acts, so the packing comes with a plate through it. Nine cells of
    // iteration count against packing strength left the plate untouched, which
    // is how it was established to be structural rather than a setting: a piece
    // that does not want it wants a different fractal, not different numbers.
    return 0.25 * abs(p.y) / scale;
}

float sdApollonian(vec3 p, float s) { return sdApollonian(p, s, 8); }

/**
 * How much the map stretched space at `p`.
 *
 * Exposed because it is the only cheap handle on WHERE IN THE HIERARCHY a hit
 * happened: a point reached through many strong inversions sits on a small
 * deep sphere, one reached through few sits on a large shallow one. Colouring
 * by it is what makes the recursion visible instead of merely present — a
 * piece shaded by position alone renders a pile of spheres, not a packing.
 *
 * Returned as a log because the scale spans many decades by construction, and
 * anything reading it wants a ramp rather than a spike.
 */
float sdApollonianDepth(vec3 p, float s, int iters) {
    float scale = 1.0;
    for (int i = 0; i < SD_FRACTAL_MAX; ++i) {
        if (i >= iters) break;
        p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
        float k = s / max(dot(p, p), 1.0e-6);
        p *= k;
        scale *= k;
    }
    return log(max(scale, 1.0e-6));
}

/**
 * One step of the box fold used by the Mandelbox family.
 *
 * Reflects any component past `limit` back across it. Kept separate from the
 * Apollonian because it is the other classic fold and pieces mix them: a box
 * fold before a sphere inversion gives a very different packing from either.
 */
vec3 sdBoxFold(vec3 p, float limit) {
    return clamp(p, -limit, limit) * 2.0 - p;
}

/**
 * One step of the sphere fold: points inside `inner` are scaled up by the
 * fixed ratio, points between `inner` and `outer` are inverted, points outside
 * are left alone. Returns the scale factor applied, which the caller must
 * accumulate — forgetting to is the classic way a Mandelbox comes out as a
 * blurry cloud with no surface.
 */
float sdSphereFold(inout vec3 p, float inner, float outer) {
    float r2 = dot(p, p);
    if (r2 < inner * inner) {
        float f = (outer * outer) / (inner * inner);
        p *= f;
        return f;
    }
    if (r2 < outer * outer) {
        float f = (outer * outer) / r2;
        p *= f;
        return f;
    }
    return 1.0;
}

/**
 * Mandelbox: the box fold and the sphere fold composed, with a linear scaling
 * between them.
 *
 * The counterpart to the Apollonian and here for a specific reason — it is
 * bounded and it has NO PLATE. The Apollonian's plate is the price of its
 * axis-aligned final measure; the Mandelbox measures `length(z)` and so is
 * isotropic all the way through, which makes it the right shape when the
 * recursion is meant to be the whole object rather than something sitting on a
 * surface.
 *
 * `dr` is the running derivative and it is the entire correctness story. Each
 * operation stretches space by a known factor; the returned distance is only a
 * valid bound if every one of those factors is accumulated. Dropping the sphere
 * fold's contribution is the classic bug and it does not look like a bug — it
 * looks like a Mandelbox with a soft, slightly melted surface, because the
 * marcher is overstepping by exactly the factor that went missing.
 *
 * Negative `scale` is normal and is what gives the family its characteristic
 * folded-inward look; the derivative uses `abs(scale)` for that reason.
 */
float sdMandelbox(vec3 p, float scale, int iters, float inner, float outer) {
    vec3 z = p;
    float dr = 1.0;
    for (int i = 0; i < SD_FRACTAL_MAX; ++i) {
        if (i >= iters) break;
        z = sdBoxFold(z, 1.0);
        dr *= sdSphereFold(z, inner, outer);
        z = z * scale + p;
        dr = dr * abs(scale) + 1.0;
    }
    return length(z) / abs(dr);
}

float sdMandelbox(vec3 p, float scale, int iters) {
    return sdMandelbox(p, scale, iters, 0.5, 1.0);
}

/** Running derivative of the Mandelbox, for colouring by recursion depth. */
float sdMandelboxDepth(vec3 p, float scale, int iters) {
    vec3 z = p;
    float dr = 1.0;
    for (int i = 0; i < SD_FRACTAL_MAX; ++i) {
        if (i >= iters) break;
        z = sdBoxFold(z, 1.0);
        dr *= sdSphereFold(z, 0.5, 1.0);
        z = z * scale + p;
        dr = dr * abs(scale) + 1.0;
    }
    return log(max(dr, 1.0e-6));
}
