#pragma once
#include "core/math.glsl"

// Ray setup: turning a point on the image into a ray, and knowing how wide a
// pixel is out there.
//
// SEPARATE FROM march.glsl ON PURPOSE. That file declares `float sceneSdf(vec3);`
// — the one sanctioned hole in basics/ — so anything including it inherits an
// obligation to define a scene. A camera has nothing to do with the scene, and
// 008 is the piece that made the coupling visible: it integrates a volume, has
// no surface to march at all, and would have had to define a fake sceneSdf
// purely to construct a ray. march.glsl includes this, so nothing that used
// rmCamera before has to change.

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
