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

// ---- projections ------------------------------------------------------------
//
// A direction in the camera's own (right, up, forward) basis, so a caller with
// no three-dimensional world to point a camera at can still have a lens. 012 is
// that caller: a point of its spacetime is (l, a direction on a sphere), which
// `rmCamera` has no way to represent.
//
// `rmCamera` IS NOT REWIRED TO USE THESE, though it obviously could be. The
// expression there sums its three basis vectors in one order and any rewrite
// sums them in another, which changes the last bit of a float and therefore
// every committed reference image in the repo. There is nothing to gain that is
// worth regenerating twelve golden images for.

/** Rectilinear pinhole. `fov` is the vertical field of view, radians. */
vec3 rmDirPinhole(vec2 artUv, float fov) {
    return normalize(vec3(artUv * 2.0, 1.0 / tan(fov * 0.5)));
}

/**
 * Equidistant fisheye: screen radius maps LINEARLY to angle from the axis.
 *
 * Which is the only way to photograph something that fills a hemisphere. A
 * pinhole's tan() runs to infinity at 180 degrees, so a subject sitting at
 * exactly 90 degrees off-axis — the two universes' horizon at the throat of
 * 012 — is not merely distorted by a rectilinear lens, it is unreachable at any
 * field of view. `fov` may go to TAU here: at 360 degrees the frame holds the
 * entire sphere, with the point directly behind the camera smeared around the
 * rim.
 */
vec3 rmDirFisheye(vec2 artUv, float fov) {
    float r = length(artUv) * 2.0;
    // Straight ahead is a single point and its azimuth is undefined; picking one
    // keeps normalize() away from a zero vector rather than repairing a NaN.
    vec2 dir = r > 1.0e-6 ? artUv / (r * 0.5) : vec2(1.0, 0.0);
    float a = r * fov * 0.5;
    return vec3(dir * sin(a), cos(a));
}
