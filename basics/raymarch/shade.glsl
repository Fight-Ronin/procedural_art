#pragma once
#include "core/math.glsl"
#include "raymarch/march.glsl"

/** Five-tap ambient occlusion (IQ). Cheap, and enough to seat an object. */
float rmAo(vec3 p, vec3 n, float radius) {
    float occ = 0.0;
    float sca = 1.0;
    for (int i = 0; i < 5; ++i) {
        float h = 0.01 + radius * float(i) / 4.0;
        float d = sceneSdf(p + n * h);
        occ += (h - d) * sca;
        sca *= 0.75;
    }
    return sat(1.0 - 3.0 * occ);
}

/**
 * Soft shadow by penumbra estimation (IQ). `k` is the light's angular size:
 * larger is sharper. Relies on the field being a true distance — a heavily
 * smooth-unioned scene will produce banding here, which is the usual first
 * symptom that a field is no longer Lipschitz.
 */
float rmSoftShadow(vec3 ro, vec3 rd, float tMin, float tMax, float k, int maxSteps) {
    float res = 1.0;
    float t = tMin;
    for (int i = 0; i < maxSteps; ++i) {
        float d = sceneSdf(ro + rd * t);
        res = min(res, k * d / t);
        t += clamp(d, 0.008, 0.2);
        if (res < 0.002 || t > tMax) break;
    }
    return sat(res);
}

/** Curvature estimate — useful for edge highlights and for tinting seams. */
float rmCurvature(vec3 p, vec3 n, float eps) {
    return (sceneSdf(p + n * eps) + sceneSdf(p - n * eps) - 2.0 * sceneSdf(p)) / (eps * eps);
}
