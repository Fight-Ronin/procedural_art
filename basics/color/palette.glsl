#pragma once
#include "core/const.glsl"
#include "core/math.glsl"
#include "color/spaces.glsl"

/**
 * IQ's cosine palette. Four vec3 controls (bias, amplitude, frequency, phase)
 * give a smooth cyclic ramp with no lookup table and no banding at any
 * resolution — which is exactly what print output needs.
 *
 * Values are linear light. Keep amplitudes modest or you clip.
 */
vec3 colCosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(TAU * (c * t + d));
}

/** A warm, low-key default worth starting from. */
vec3 colCosPaletteDefault(float t) {
    return colCosPalette(t,
        vec3(0.32, 0.28, 0.30),
        vec3(0.34, 0.30, 0.26),
        vec3(1.00, 0.95, 0.85),
        vec3(0.00, 0.12, 0.28));
}

/** Perceptual two-stop ramp. Endpoints are linear light. */
vec3 colRamp2(float t, vec3 c0, vec3 c1) {
    return colMixOklab(c0, c1, sat(t));
}

/** Perceptual three-stop ramp with the pivot at t = 0.5. */
vec3 colRamp3(float t, vec3 c0, vec3 c1, vec3 c2) {
    t = sat(t);
    return t < 0.5 ? colMixOklab(c0, c1, t * 2.0)
                   : colMixOklab(c1, c2, t * 2.0 - 1.0);
}
