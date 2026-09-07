#pragma once
#include "core/math.glsl"

// EVERYTHING in basics/ and in artwork mainImage() works in LINEAR sRGB.
// The single encode to display space happens in viz's epilogue, once, at the
// very end. Mixing encoded and linear values is the reason a series of pieces
// drifts out of colour agreement with itself.

float colLinearToSrgb1(float c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * safePow(c, 1.0 / 2.4) - 0.055;
}
float colSrgbToLinear1(float c) {
    return c <= 0.04045 ? c / 12.92 : safePow((c + 0.055) / 1.055, 2.4);
}

vec3 colLinearToSrgb(vec3 c) {
    return vec3(colLinearToSrgb1(c.r), colLinearToSrgb1(c.g), colLinearToSrgb1(c.b));
}
vec3 colSrgbToLinear(vec3 c) {
    return vec3(colSrgbToLinear1(c.r), colSrgbToLinear1(c.g), colSrgbToLinear1(c.b));
}

// ---- Oklab (Björn Ottosson) ------------------------------------------------
// Perceptually uniform. Interpolate here, not in sRGB, or your gradients pick
// up muddy grey midpoints and hue shifts through the blues.

vec3 colLinearToOklab(vec3 c) {
    float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
    float l_ = sign(l) * safePow(abs(l), 1.0 / 3.0);
    float m_ = sign(m) * safePow(abs(m), 1.0 / 3.0);
    float s_ = sign(s) * safePow(abs(s), 1.0 / 3.0);
    return vec3(
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}

vec3 colOklabToLinear(vec3 c) {
    float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
    float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
    float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
    float l = l_ * l_ * l_;
    float m = m_ * m_ * m_;
    float s = s_ * s_ * s_;
    return vec3(
         4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

/** Perceptual mix. Use this instead of mix() on linear RGB for gradients. */
vec3 colMixOklab(vec3 a, vec3 b, float t) {
    return colOklabToLinear(mix(colLinearToOklab(a), colLinearToOklab(b), t));
}

/** Oklab lightness only — a decent perceptual luma. */
float colLuma(vec3 linear) { return colLinearToOklab(linear).x; }

/**
 * Rec.709 luminance of a linear colour. Radiometric, not perceptual.
 *
 * The one to threshold HDR on. `colLuma` is Oklab lightness, which is a
 * cube-root of the radiance and is built to describe colours a display can
 * show — so it COMPRESSES exactly the range above 1 that a highlight lives in.
 * Measured on 008: a core at linear (1.88, 1.48, 0.83) has an Oklab lightness
 * of 1.15, so a threshold of 1.0 kept a thirteenth of its energy and the bloom
 * pass rendered a halo indistinguishable from no halo at all. In linear
 * luminance the same colour reads 1.58, and thresholding it means what it says.
 */
float colLumaLinear(vec3 linear) { return dot(linear, vec3(0.2126, 0.7152, 0.0722)); }
