#pragma once
#include "core/math.glsl"

// Exact signed distance functions, after Inigo Quilez's collection.
// "Exact" matters: a bounded or scaled-down field still renders, but the
// sphere-tracing loop takes far more steps and soft shadows / AO go wrong,
// because both assume the value really is a distance.

float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdPlane(vec3 p, vec3 n, float h) { return dot(p, normalize(n)) + h; }

float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }

float sdTorus(vec3 p, float major, float minor) {
    return length(vec2(length(p.xz) - major, p.y)) - minor;
}

/** Torus cut to an arc. sc = vec2(sin, cos) of half the opening angle. */
float sdCappedTorus(vec3 p, vec2 sc, float major, float minor) {
    p.x = abs(p.x);
    float k = (sc.y * p.x > sc.x * p.y) ? dot(p.xy, sc) : length(p.xy);
    return sqrt(dot(p, p) + major * major - 2.0 * major * k) - minor;
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a, ba = b - a;
    float h = sat(dot(pa, ba) / dot(ba, ba));
    return length(pa - ba * h) - r;
}

float sdCylinder(vec3 p, float h, float r) {
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCone(vec3 p, vec2 sc, float h) {
    vec2 q = h * vec2(sc.x / sc.y, -1.0);
    vec2 w = vec2(length(p.xz), p.y);
    vec2 a = w - q * sat(dot(w, q) / dot(q, q));
    vec2 b = w - q * vec2(sat(w.x / q.x), 1.0);
    float k = sign(q.y);
    float d = min(dot(a, a), dot(b, b));
    float s = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
    return sqrt(d) * sign(s);
}

/** Two interlocking half-tori joined by straight sections — a chain link. */
float sdLink(vec3 p, float len, float major, float minor) {
    vec3 q = vec3(p.x, max(abs(p.y) - len, 0.0), p.z);
    return length(vec2(length(q.xy) - major, q.z)) - minor;
}

float sdOctahedron(vec3 p, float s) {
    p = abs(p);
    float m = p.x + p.y + p.z - s;
    vec3 q;
    if (3.0 * p.x < m) q = p.xyz;
    else if (3.0 * p.y < m) q = p.yzx;
    else if (3.0 * p.z < m) q = p.zxy;
    else return m * 0.57735027;
    float k = clamp(0.5 * (q.z - q.y + s), 0.0, s);
    return length(vec3(q.x, q.y - s + k, q.z - k));
}

float sdHexPrism(vec3 p, vec2 h) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
    p = abs(p);
    p.xy -= 2.0 * min(dot(k.xy, p.xy), 0.0) * k.xy;
    vec2 d = vec2(
        length(p.xy - vec2(clamp(p.x, -k.z * h.x, k.z * h.x), h.x)) * sign(p.y - h.x),
        p.z - h.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

/**
 * A tube around a (p,q) torus knot, found by walking the curve. Not an exact
 * SDF — it under-estimates slightly between samples — so keep `steps` high
 * enough for the tube radius you use, and expect the marcher to take a few more
 * iterations. This is the honest way to get pretzels, trefoils and ribbons;
 * closed-form knot SDFs do not exist.
 */
float sdKnot(vec3 p, float pp, float qq, float major, float tube, int steps) {
    float best = BIG;
    float dt = TAU / float(steps);
    for (int i = 0; i < steps; ++i) {
        float t = float(i) * dt;
        float r = major + cos(qq * t);
        vec3 c = vec3(r * cos(pp * t), sin(qq * t), r * sin(pp * t));
        best = min(best, dot(p - c, p - c));
    }
    return sqrt(best) - tube;
}
