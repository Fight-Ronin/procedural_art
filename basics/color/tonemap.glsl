#pragma once
#include "core/math.glsl"

/** Narkowicz's ACES fit. Fast, filmic shoulder, keeps highlights from clipping flat. */
vec3 colTonemapAces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return sat((x * (a * x + b)) / (x * (c * x + d) + e));
}

/** Reinhard with a white point. Gentler than ACES, less contrast. */
vec3 colTonemapReinhard(vec3 x, float white) {
    return sat(x * (1.0 + x / (white * white)) / (1.0 + x));
}

/** Exposure in stops, applied in linear light. Apply before tonemapping. */
vec3 colExposure(vec3 x, float stops) { return x * exp2(stops); }
