#pragma once
#include "core/math.glsl"

// Combination operators.
//
// The smooth variants all shrink the true distance somewhat near the blend, so
// a scene built from them is a slight under-estimate. That is fine for sphere
// tracing but means the marcher should not take the value as gospel — see the
// step-limit notes in raymarch/march.glsl.

float opUnion(float a, float b)     { return min(a, b); }

/**
 * CARVES `a` OUT OF `b`, in that order — the cutter first, the material second.
 *
 * Worth stating because it is the opposite of how the operation is usually
 * written down ("b minus a") and the mistake is silent: swapping the arguments
 * gives the INTERSECTION of a with the complement of b, which is a perfectly
 * valid solid that simply is not the one you asked for. 006 lost a render to
 * exactly that, and the shape it produced looked deliberate.
 */
float opSubtract(float a, float b)  { return max(-a, b); }

float opIntersect(float a, float b) { return max(a, b); }

/** Polynomial smooth minimum (IQ). k is the blend width in world units. */
float opSmoothUnion(float a, float b, float k) {
    float h = sat(0.5 + 0.5 * (b - a) / k);
    return mix(b, a, h) - k * h * (1.0 - h);
}
float opSmoothSubtract(float a, float b, float k) {
    float h = sat(0.5 - 0.5 * (b + a) / k);
    return mix(b, -a, h) + k * h * (1.0 - h);
}
float opSmoothIntersect(float a, float b, float k) {
    float h = sat(0.5 - 0.5 * (b - a) / k);
    return mix(b, a, h) + k * h * (1.0 - h);
}

/** Same as opSmoothUnion but also returns the blend factor, for shading. */
float opSmoothUnionM(float a, float b, float k, out float blend) {
    blend = sat(0.5 + 0.5 * (b - a) / k);
    return mix(b, a, blend) - k * blend * (1.0 - blend);
}

/** Inflate by r. Rounds every convex edge. */
float opRound(float d, float r) { return d - r; }

/** Turn a solid into a shell of thickness 2*t. This is what makes glass read
 *  as an object with walls rather than as a lump of jelly. */
float opOnion(float d, float t) { return abs(d) - t; }

/** Extrude a 2D distance along z with half-height h. */
float opExtrude(float d2, float z, float h) {
    vec2 w = vec2(d2, abs(z) - h);
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0));
}

/** Revolve a 2D distance around the y axis at radius o. */
vec2 opRevolve(vec3 p, float o) { return vec2(length(p.xz) - o, p.y); }
