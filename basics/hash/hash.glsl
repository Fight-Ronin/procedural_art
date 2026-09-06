#pragma once

// Integer hashing, after Jarzynski & Olano, "Hash Functions for GPU Rendering"
// (JCGT 2020). These are decorrelated in every output bit, unlike the classic
// sin(dot(p, vec2(12.9898, 78.233))) trick, which visibly bands at high
// resolution and differs between drivers — fatal for reproducible print work.
//
// NAMING: hash<inputDims><outputDims>. hash21 takes vec2, returns float.

uint hashU11(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word  = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

uvec2 hashU22(uvec2 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * 1664525u;
    v.y += v.x * 1664525u;
    v ^= v >> 16u;
    v.x += v.y * 1664525u;
    v.y += v.x * 1664525u;
    v ^= v >> 16u;
    return v;
}

uvec3 hashU33(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

/** uint -> [0,1) */
float hashUnit(uint x) { return float(x) * (1.0 / 4294967296.0); }

// ---- float entry points, all returning [0,1) -------------------------------

float hash11(float p) { return hashUnit(hashU11(floatBitsToUint(p))); }
float hash21(vec2  p) { return hashUnit(hashU22(floatBitsToUint(p)).x); }
float hash31(vec3  p) { return hashUnit(hashU33(floatBitsToUint(p)).x); }

vec2 hash12(float p) { return vec2(hashU22(uvec2(floatBitsToUint(p), 0x9E3779B9u))) * (1.0 / 4294967296.0); }
vec2 hash22(vec2  p) { return vec2(hashU22(floatBitsToUint(p))) * (1.0 / 4294967296.0); }
vec3 hash23(vec2  p) { return vec3(hashU33(uvec3(floatBitsToUint(p), 0x9E3779B9u))) * (1.0 / 4294967296.0); }
vec3 hash33(vec3  p) { return vec3(hashU33(floatBitsToUint(p))) * (1.0 / 4294967296.0); }

// ---- seeded variants -------------------------------------------------------
// basics/ never reads uSeed itself; the artwork passes it in. That keeps these
// pure and keeps every piece reproducible from (seed, frame) alone.

float hash21s(vec2 p, int seed) {
    return hashUnit(hashU33(uvec3(floatBitsToUint(p), uint(seed))).x);
}
vec2 hash22s(vec2 p, int seed) {
    uvec3 h = hashU33(uvec3(floatBitsToUint(p), uint(seed)));
    return vec2(h.xy) * (1.0 / 4294967296.0);
}
