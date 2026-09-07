#pragma once
#include "core/math.glsl"

// Exact signed distance functions in the plane, after Inigo Quilez's collection.
//
// Why the repo needed these at all: `sdf/prim3d.glsl` covers shapes you march
// through, and everything made with it is soft — surfaces lit by a camera. A
// plane figure is a different job. It is what deliberate geometry is made of:
// hard edges, frames, rules, arcs, tiles, glyph-shaped things. Six pieces in,
// this repo could produce fields, glass, a simulation, flow, terrain and
// architecture, and could not produce a drawing.
//
// EXACTNESS BUYS SOMETHING HERE THAT IT DOES NOT BUY IN 3D. An exact signed
// distance has |grad d| = 1 everywhere it is differentiable, so the pixel
// footprint of the FIELD is just the pixel footprint of the PLANE — known
// analytically from `pxSize()` and whatever scale the artwork works at. A 2D
// piece therefore needs no screen-space derivative at all:
//
//     float px = pxSize() * scale;            // exact, not estimated
//     float ink = aaStep(sdSegment(p, a, b) - halfWidth, px);
//
// That matters beyond tidiness. `dFdx` is a difference across the rasterizer's
// 2x2 quad, which is what forces even tile origins on export and what makes a
// derivative inside a data-dependent branch undefined. A drawing built on exact
// distances sidesteps both, and antialiases exactly rather than approximately.
//
// The bare-distance convention below (`sdSegment`, `sdArc` return an UNSIGNED
// distance to a curve, not to a filled shape) is deliberate for the same
// reason: a curve has no inside, and `d - halfWidth` is then the stroke as a
// proper signed region, which composes with `opIntersect` and friends like any
// other shape. `aaBand(d, halfWidth, px)` draws the same stroke directly.
//
// Composition note: `max()`-based booleans are NOT exact — outside an
// intersection the true distance is larger than `max(a, b)`. They under-
// estimate, which is safe, and `test/sdf.test.ts` therefore checks exactness on
// primitives and the Lipschitz bound on everything.

float sdCircle(vec2 p, float r) { return length(p) - r; }

/** Half-extents `b`, centred at the origin. Overloads the 3D box. */
float sdBox(vec2 p, vec2 b) {
    vec2 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float sdRoundBox(vec2 p, vec2 b, float r) { return sdBox(p, b - r) - r; }

/**
 * Distance to the SEGMENT a-b. Unsigned: a segment has no interior.
 *
 * A stroke of total width 2t is `sdSegment(p, a, b) - t`, with round caps. For
 * flat caps, intersect with a box.
 */
float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = sat(dot(pa, ba) / dot(ba, ba));
    return length(pa - ba * h);
}

/**
 * Distance to a circular ARC of radius `ra`, centred at the origin, symmetric
 * about the +y axis and spanning +/- the angle whose sine and cosine are `sc`.
 *
 * `sc` is passed rather than the angle because it is almost always a constant:
 * `sdArcSc(radians)` builds it when it is not. A quarter-arc opening upward is
 * `sdArcSc(PI * 0.25)`.
 */
float sdArc(vec2 p, vec2 sc, float ra) {
    p.x = abs(p.x);
    return (sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra);
}

/** The (sin, cos) pair `sdArc` wants, from a half-aperture in radians. */
vec2 sdArcSc(float halfAngle) { return vec2(sin(halfAngle), cos(halfAngle)); }

/**
 * Regular polygon with `n` sides and CIRCUMRADIUS `r` — one vertex on +y.
 *
 * `n` is a float so it can be driven by a parameter; it is used as an angle
 * divisor, not a loop bound, so a non-integer value is a valid (if strange)
 * shape rather than an error.
 */
float sdNgon(vec2 p, float r, float n) {
    float an = PI / n;
    vec2 acs = vec2(cos(an), sin(an));
    float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
    p = length(p) * vec2(cos(bn), abs(sin(bn)));
    p -= r * acs;
    p.y += clamp(-p.y, 0.0, r * acs.y);
    return length(p) * sign(p.x);
}

/**
 * Distance to the boundary of the half-plane through `o` with outward normal
 * `n`. Exact and 1-Lipschitz for any unit `n`; the cheapest way to trim a
 * composition to a frame or a diagonal.
 */
float sdHalfPlane(vec2 p, vec2 o, vec2 n) { return dot(p - o, normalize(n)); }
