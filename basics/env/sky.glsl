#pragma once
#include "core/math.glsl"
#include "noise/fbm.glsl"

// Environment lookups, keyed by RAY DIRECTION rather than screen position.
//
// This distinction is the whole game for transmissive work. A background drawn
// from artCoord() is a flat backdrop: refracted rays have nowhere to go, and
// the glass comes back as grey mush. A direction-keyed environment is a world
// the object sits inside, so every bent ray lands somewhere with structure —
// which is what the eye reads as transparency.
//
// Values are linear light and may exceed 1.0. Highlights want the headroom;
// the tonemap at the end brings them back.

/** Vertical gradient plus a soft sun disc. The minimum viable world. */
vec3 envGradient(vec3 rd, vec3 down, vec3 up, vec3 sunDir, vec3 sunColor, float sunSize) {
    float h = sat(rd.y * 0.5 + 0.5);
    vec3 sky = mix(down, up, h * h);
    float c = sat(dot(rd, normalize(sunDir)));
    float disc = pow(c, max(1.0, 2.0 / max(sunSize, 1e-3)));
    return sky + sunColor * disc;
}

/**
 * Three soft rectangular sources on a dark ground — a photographer's setup.
 * Glass shows its shape through the edges of what it reflects, so a few hard
 * bright shapes read far better than a smooth gradient, which gives the surface
 * nothing to bend.
 */
vec3 envStudio(vec3 rd, vec3 keyDir, vec3 fillDir, vec3 rimDir,
               float keyPower, float fillPower, float rimPower, vec3 ambient) {
    float k = pow(sat(dot(rd, normalize(keyDir))), 24.0) * keyPower;
    float f = pow(sat(dot(rd, normalize(fillDir))), 8.0) * fillPower;
    float r = pow(sat(dot(rd, normalize(rimDir))), 64.0) * rimPower;

    // A HARD horizon. Smooth gradients give a refracted ray nothing to reveal,
    // and the object comes back reading as opaque stone; a sharp edge bends
    // visibly and is what makes the far side legible through the near side.
    float horizon = smoothstep(0.015, -0.015, rd.y);
    vec3 ground = ambient * 0.25;
    vec3 sky = ambient + vec3(0.35) * sat(rd.y * 1.4 + 0.25);

    return mix(sky, ground, horizon) + vec3(k + f * 0.6 + r);
}

/** Banded environment. Hard edges make refraction legible; good for study. */
vec3 envBands(vec3 rd, float count, vec3 a, vec3 b) {
    float s = step(0.5, fract(atan(rd.z, rd.x) / TAU * count));
    return mix(a, b, s) * (0.35 + 0.65 * sat(rd.y * 0.5 + 0.5));
}

/** Cloudy dome. Slower, but gives refraction organic structure to pick up. */
vec3 envClouded(vec3 rd, vec3 down, vec3 up, float scale, int octaves) {
    float n = nzFbm21(rd.xz * scale / max(0.3, rd.y + 1.2), octaves) * 0.5 + 0.5;
    float h = sat(rd.y * 0.5 + 0.5);
    return mix(down, up, h * h) * (0.6 + 0.8 * n);
}
