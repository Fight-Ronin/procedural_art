#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"

// Value noise: hash the lattice, quintic-interpolate between corners.
// Cheaper than gradient noise, blockier look. Returns [0,1).
// NAMING: nz<kind><inputDims><outputDims>.

float nzValue21(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = quintic(f);
    float a = hash21(i + vec2(0.0, 0.0));
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float nzValue31(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = quintic(f);
    float a = mix(mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), u.x),
                  mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), u.x), u.y);
    float b = mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), u.x),
                  mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), u.x), u.y);
    return mix(a, b, u.z);
}

/** Signed, [-1,1). */
float nzValue21s(vec2 p) { return nzValue21(p) * 2.0 - 1.0; }
float nzValue31s(vec3 p) { return nzValue31(p) * 2.0 - 1.0; }
