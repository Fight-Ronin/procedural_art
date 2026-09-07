#pragma once
#include "core/math.glsl"

// Antialiased edges whose INK DOES NOT CHANGE WITH OUTPUT RESOLUTION.
//
// This directory exists because 001 failed a test. The piece drew contour
// lines the usual way —
//
//     float w    = max(fwidth(bands), 1e-4);
//     float line = 1.0 - smoothstep(0.0, w * 1.1, edge - 0.02);
//
// — and `test/render.test.ts` caught the whole image sitting 1.76/255 darker
// at 300px than at 900px. The cause is structural, not a typo: that smoothstep
// runs from the threshold OUTWARD, so it adds roughly half a pixel of extra
// coverage to each side of every line. Half a pixel is a large fraction of a
// thin line at 300px and a small one at 900px, so the amount of ink on the
// page — and therefore the average brightness of the picture — is a function
// of how big the picture is. On a preview that reads as "nice crisp lines". On
// a 4000px print it reads as lines that came out too fine, and there is no
// setting to fix it because the setting is the resolution.
//
// The fix is to stop treating the pixel as the unit. A width here is stated in
// DOMAIN units — fractions of a contour band, art-space distance, whatever the
// argument's units are — and the pixel footprint enters only as the filter the
// output is being resampled through. Both functions below are the exact
// box-filter coverage of their shape under a linear approximation of the field
// over one pixel, so:
//
//   * the mean coverage over the image equals the true geometric coverage, at
//     every resolution, which is precisely the property that failed;
//   * a feature thinner than a pixel FADES rather than aliasing or vanishing,
//     because partial coverage is what the exact answer already says. No
//     `max(width, onePixel)` floor is needed, and adding one would reintroduce
//     the very resolution dependence this is here to remove.
//
// Everything is pure: a value, a width, a footprint, no uniforms. The footprint
// normally comes from `aaFootprint()` below, or from viz's `pxSize()` when the
// quantity is art-space distance and the derivative is known analytically.

/**
 * Pixel footprint of a scalar field: how much `x` changes across one pixel,
 * measured along its own gradient.
 *
 * `fwidth()` is the usual answer and is |dx| + |dy|, which overestimates a
 * diagonal gradient by up to sqrt(2) — visible as edges that thicken as they
 * turn. The Euclidean length is the honest footprint.
 *
 * The floor is not cosmetic: where a field is locally flat the footprint is 0
 * and the coverage below would divide by it. A flat field has no edge to
 * antialias anyway, so any tiny positive value gives the right answer there.
 *
 * THIS IS THE ONE FUNCTION HERE THAT IS NOT A PURE FUNCTION OF ITS ARGUMENT.
 * Derivatives are differences across the rasterizer's 2x2 quad, so the answer
 * depends on the three neighbouring fragments. Two consequences:
 *
 *   * calling it under data-dependent control flow — a branch on the field, on
 *     a hit test, on anything that can differ between the four fragments of a
 *     quad — is undefined in GLSL ES 3.0. A branch on a uniform is fine, since
 *     the whole quad takes the same path. Compute the footprint before the
 *     branch if in doubt.
 *   * a tile boundary must not cut a quad, which is why `render/tile.ts`
 *     requires even tile origins. 001's contours are the canary there.
 */
float aaFootprint(float x) {
    return max(length(vec2(dFdx(x), dFdy(x))), 1e-8);
}

/**
 * Coverage of the half-space `x < 0` over one pixel, given footprint `w`.
 *
 * Exact for a box filter when x is locally linear: the pixel covers
 * [x - w/2, x + w/2], and the fraction of that below zero is 0.5 - x/w.
 *
 * Use in place of `smoothstep(-w, w, x)` and friends. Unlike smoothstep this
 * is centred on the threshold by construction, so it neither grows nor shrinks
 * the region it is filtering.
 */
float aaStep(float x, float w) {
    return sat(0.5 - x / max(w, 1e-8));
}

/**
 * Coverage of the band `|x| < h` over one pixel, given footprint `w`.
 *
 * The integral of this over any region equals the region's true band area, for
 * every w — that is the resolution-stability property, and `test/aa.test.ts`
 * measures it rather than taking it on faith.
 *
 * `h` is a HALF-width in the units of `x`. A line 0.04 bands wide is
 * `aaBand(d, 0.02, w)`, and it stays 0.04 bands wide on a 4000px print.
 *
 * `x` may be signed or a non-negative distance; both work, because the two
 * half-space coverages simply telescope. Their difference integrates to
 * exactly 2h whatever w is, which is the whole point.
 */
float aaBand(float x, float h, float w) {
    return aaStep(x - h, w) - aaStep(x + h, w);
}

/**
 * Distance from `x` to the nearest integer, in the units of `x`. In [0, 0.5].
 *
 * The natural argument for `aaBand` when drawing a periodic family of lines
 * (contours, grids, rings): `aaBand(aaRepeat(v), h, aaFootprint(v))`.
 *
 * THE FOOTPRINT MUST COME FROM `x`, NOT FROM THIS RESULT. The derivative of a
 * sawtooth is a delta function at every seam, so `aaFootprint(aaRepeat(v))`
 * puts a blown-out dot on every line — a bug that looks, at a glance, like the
 * lines are simply brighter where they bunch up.
 */
float aaRepeat(float x) {
    return 0.5 - abs(fract(x) - 0.5);
}
