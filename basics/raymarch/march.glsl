#pragma once
#include "core/math.glsl"

// GLSL has no function pointers, so the scene enters the library through a
// prototype the artwork fills in. This is the one documented place where a
// basics/ module depends on the artwork; it stays uniform-free and
// texture-free, so the purity rule is intact.
float sceneSdf(vec3 p);

struct RmHit {
    float t;      // distance along the ray
    int   steps;  // iterations used; cheap heat-map material
    bool  hit;
};

/**
 * Sphere tracing with a CONE-TRACED epsilon.
 *
 * The usual `if (d < 0.001)` looks clean at 512px and then fails at print size
 * in both directions: far surfaces stop converging (holes and speckle) while
 * near ones burn steps chasing a tolerance far below one pixel. Instead the
 * tolerance is the world-space footprint of one pixel at the current distance,
 * so the surface is resolved to exactly the precision the output can show.
 * `footprint` is pxSize() * (focal scale), supplied by the artwork — basics/
 * cannot read uniforms.
 *
 * `stepScale` below 1 is the escape hatch for fields that are not proper
 * distances: opTwist, opBend and heavy opSmoothUnion all over-estimate, and a
 * full step will tunnel through thin features. 0.6-0.8 is typical there, 1.0
 * for exact fields.
 */
RmHit rmMarch(vec3 ro, vec3 rd, float tMin, float tMax, int maxSteps,
              float footprint, float stepScale) {
    RmHit h;
    h.t = tMin;
    h.steps = 0;
    h.hit = false;
    for (int i = 0; i < maxSteps; ++i) {
        h.steps = i;
        float d = sceneSdf(ro + rd * h.t);
        float eps = max(footprint * h.t, 1e-5);
        if (d < eps) { h.hit = true; break; }
        h.t += d * stepScale;
        if (h.t > tMax) break;
    }
    return h;
}

/**
 * March the interior — the negated field — from just inside a surface until it
 * exits. This is the second half of refraction: a ray that enters glass has to
 * find its way out before it can be bent again.
 */
RmHit rmMarchInside(vec3 ro, vec3 rd, float tMax, int maxSteps,
                    float footprint, float stepScale) {
    RmHit h;
    h.t = 0.0;
    h.steps = 0;
    h.hit = false;
    for (int i = 0; i < maxSteps; ++i) {
        h.steps = i;
        float d = -sceneSdf(ro + rd * h.t);
        float eps = max(footprint * h.t, 1e-5);
        if (d < eps) { h.hit = true; break; }
        h.t += d * stepScale;
        if (h.t > tMax) break;
    }
    return h;
}

/**
 * Tetrahedron normal: four evaluations instead of the six a central difference
 * needs, with no bias in any axis. `eps` should track the pixel footprint too —
 * too small and it samples numerical noise, too large and edges round off.
 */
vec3 rmNormal(vec3 p, float eps) {
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
        k.xyy * sceneSdf(p + k.xyy * eps) +
        k.yyx * sceneSdf(p + k.yyx * eps) +
        k.yxy * sceneSdf(p + k.yxy * eps) +
        k.xxx * sceneSdf(p + k.xxx * eps));
}

/** Ray from a pinhole camera looking at `target`. `fov` is vertical, radians. */
void rmCamera(vec2 artUv, vec3 eye, vec3 target, vec3 up, float fov,
              out vec3 ro, out vec3 rd) {
    vec3 f = normalize(target - eye);
    vec3 r = normalize(cross(f, up));
    vec3 u = cross(r, f);
    float z = 1.0 / tan(fov * 0.5);
    ro = eye;
    rd = normalize(artUv.x * r * 2.0 + artUv.y * u * 2.0 + f * z);
}

/** The world-space footprint of one output pixel, for rmMarch's `footprint`. */
float rmFootprint(float pixelSize, float fov) {
    return pixelSize * 2.0 * tan(fov * 0.5);
}
