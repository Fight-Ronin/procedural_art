#pragma once
#include "core/const.glsl"

// ---- clamping / remapping --------------------------------------------------

float sat(float x)  { return clamp(x, 0.0, 1.0); }
vec2  sat(vec2 x)   { return clamp(x, 0.0, 1.0); }
vec3  sat(vec3 x)   { return clamp(x, 0.0, 1.0); }
vec4  sat(vec4 x)   { return clamp(x, 0.0, 1.0); }

/** Map x from [a,b] onto [c,d]. Unclamped. */
float remap(float x, float a, float b, float c, float d) {
    return c + (d - c) * (x - a) / (b - a);
}
/** Same, clamped to [c,d]. */
float remapc(float x, float a, float b, float c, float d) {
    return c + (d - c) * sat((x - a) / (b - a));
}

// ---- rotation --------------------------------------------------------------

mat2 rot2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
}

/** Rotation about a unit axis (Rodrigues). */
mat3 rot3(vec3 axis, float a) {
    float c = cos(a), s = sin(a), k = 1.0 - c;
    vec3 u = normalize(axis);
    return mat3(
        c + u.x * u.x * k,        u.x * u.y * k - u.z * s,  u.x * u.z * k + u.y * s,
        u.y * u.x * k + u.z * s,  c + u.y * u.y * k,        u.y * u.z * k - u.x * s,
        u.z * u.x * k - u.y * s,  u.z * u.y * k + u.x * s,  c + u.z * u.z * k);
}

// ---- safe operations -------------------------------------------------------

float safeDiv(float a, float b)   { return a / (abs(b) < EPS ? sign(b + EPS) * EPS : b); }
vec2  safeNorm(vec2 v)  { float l = length(v); return l < EPS ? vec2(0.0) : v / l; }
vec3  safeNorm(vec3 v)  { float l = length(v); return l < EPS ? vec3(0.0) : v / l; }
float safePow(float x, float k)   { return pow(max(x, 0.0), k); }

// ---- shaping ---------------------------------------------------------------

/** Hermite ramp, the building block of quintic interpolation. */
float quintic(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
vec2  quintic(vec2 t)  { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
vec3  quintic(vec3 t)  { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

/**
 * Value and gradient of quintic smoothstep. The interpolant's own derivative is
 * needed because the lattice values are themselves being blended by it.
 */
vec2 quinticD(vec2 t) {
    return 30.0 * t * t * (t * (t - 2.0) + 1.0);
}

/** Peaks at 1.0 when x == k, decays either side. IQ's exponential impulse. */
float impulse(float x, float k) { float h = k * x; return h * exp(1.0 - h); }

/** Symmetric bump on [0,1], flat top controlled by k. IQ's parabola. */
float parabola(float x, float k) { return safePow(4.0 * x * (1.0 - x), k); }

/**
 * Identity for x > m, but smoothly lifted to a floor of n near zero.
 * IQ's almostIdentity — use it to keep a value away from 0 without a hard
 * max(), which would introduce a derivative discontinuity and hence an
 * antialiasing seam.
 */
float almostIdentity(float x, float m, float n) {
    if (x > m) return x;
    float a = 2.0 * n - m;
    float b = 2.0 * m - 3.0 * n;
    float t = x / m;
    return (a * t + b) * t * t + n;
}

float easeInOutCubic(float t) {
    return t < 0.5 ? 4.0 * t * t * t : 1.0 - safePow(-2.0 * t + 2.0, 3.0) * 0.5;
}

/** Seamless loop helper: 0 -> 1 -> 0 over t in [0,1], C1 continuous at the seam. */
float pingpong(float t) { return 1.0 - abs(2.0 * fract(t) - 1.0); }
