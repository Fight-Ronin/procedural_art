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

/**
 * Per-channel hyperbolic roll-off: `tanh`.
 *
 * The soft clip that emissive accumulation work tends to want. It is the
 * gentlest of the three here — slope exactly 1 at the origin, so everything
 * below about 0.5 comes through essentially untouched, and then it approaches 1
 * asymptotically and NEVER clips however large the input. ACES has a filmic toe
 * that lifts blacks and a shoulder that starts early, which is right for a lit
 * scene and wrong for a bright object on true black: it greys the void.
 *
 * The cost is that it is per-channel, so a saturated highlight desaturates
 * toward white as it saturates rather than holding its hue. For a star that is
 * the correct behaviour and not an artefact — a hot core reads white.
 */
vec3 colTonemapTanh(vec3 x) {
    // tanh saturates in float32 well before this, and exp(large) is inf.
    return tanh(min(max(x, 0.0), 16.0));
}

/** Exposure in stops, applied in linear light. Apply before tonemapping. */
vec3 colExposure(vec3 x, float stops) { return x * exp2(stops); }
