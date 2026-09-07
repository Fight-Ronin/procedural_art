#pragma once
#include "core/math.glsl"

// Domain transforms. Applied to p before evaluating a primitive.
//
// IMPORTANT: twist and bend are NON-uniform deformations. They break the
// distance property — the field still has the right zero set but over-estimates
// along the deformation, so the marcher can step through thin features. Divide
// the result by a Lipschitz bound (roughly 1 + amount * extent) or just take
// smaller steps. Every op below says whether it is distance-preserving.

/** Distance-preserving. Infinite lattice with cell size c. */
vec3 opRepeat(vec3 p, vec3 c) { return p - c * round(p / c); }

/** Distance-preserving. Lattice limited to +/- l cells. */
vec3 opRepeatLimited(vec3 p, float c, vec3 l) {
    return p - c * clamp(round(p / c), -l, l);
}

/** Distance-preserving. Mirror across the given axes. */
vec3 opMirror(vec3 p, bvec3 axes) {
    return vec3(axes.x ? abs(p.x) : p.x, axes.y ? abs(p.y) : p.y, axes.z ? abs(p.z) : p.z);
}

/**
 * Distance-preserving. n-fold rotational symmetry about the y axis.
 * A pretzel, a rose window, a gear: anything with repeated arms starts here.
 */
vec3 opPolarRepeat(vec3 p, float n) {
    float a = atan(p.z, p.x);
    float sector = TAU / n;
    a = mod(a + 0.5 * sector, sector) - 0.5 * sector;
    float r = length(p.xz);
    return vec3(r * cos(a), p.y, r * sin(a));
}

// ---- the same operations in the plane ---------------------------------------
//
// Overloads rather than `opRepeat2` names: the operation is the same operation,
// and GLSL picks by argument type. `sdf/prim2d.glsl` overloads `sdBox` the same
// way. Where the shape genuinely differs between dimensions the name does too —
// a circle is not a sphere.

/** Distance-preserving. Infinite lattice with cell size c. */
vec2 opRepeat(vec2 p, vec2 c) { return p - c * round(p / c); }

/** Distance-preserving. Lattice limited to +/- l cells. */
vec2 opRepeatLimited(vec2 p, float c, vec2 l) {
    return p - c * clamp(round(p / c), -l, l);
}

/** Distance-preserving. Mirror across the given axes. */
vec2 opMirror(vec2 p, bvec2 axes) {
    return vec2(axes.x ? abs(p.x) : p.x, axes.y ? abs(p.y) : p.y);
}

/** Distance-preserving. n-fold rotational symmetry about the origin. */
vec2 opPolarRepeat(vec2 p, float n) {
    float a = atan(p.y, p.x);
    float sector = TAU / n;
    a = mod(a + 0.5 * sector, sector) - 0.5 * sector;
    return length(p) * vec2(cos(a), sin(a));
}

/** Distance-preserving. Stretch by h along each axis without rounding. */
vec2 opElongate(vec2 p, vec2 h) { return p - clamp(p, -h, h); }

/**
 * The cell index of p on a lattice of size c. The companion to `opRepeat`:
 * `opRepeat` gives the position within the cell, this gives which cell, so a
 * hash of it can decide what the cell contains.
 */
vec2 opCell(vec2 p, vec2 c) { return round(p / c); }

/** NOT distance-preserving. Rotate about y by k radians per unit of y. */
vec3 opTwist(vec3 p, float k) {
    float c = cos(k * p.y), s = sin(k * p.y);
    return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

/** NOT distance-preserving. Bend about z by k radians per unit of x. */
vec3 opBend(vec3 p, float k) {
    float c = cos(k * p.x), s = sin(k * p.x);
    return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

/** Distance-preserving. Stretch by h along each axis without rounding. */
vec3 opElongate(vec3 p, vec3 h) { return p - clamp(p, -h, h); }

/** Uniform scale. Remember to multiply the returned distance back by s. */
vec3 opScale(vec3 p, float s) { return p / s; }
