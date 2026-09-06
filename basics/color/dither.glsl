#pragma once
#include "core/math.glsl"
#include "hash/hash.glsl"

// Dither: trading banding for noise, on purpose.
//
// Rounding a smooth gradient to 8 bits turns it into flat steps. On screen the
// steps are usually narrow enough to pass; in print they are not. Measured on
// 001, along a row, the longest run of one identical 8-bit value:
//
//   900px output    p99 4px    longest 29px    0.7% of the frame in runs >=12px
//   2000px output   p99 6px    longest 69px    3.2%
//
// and the scaling is linear in output size, because a gradient spread over
// twice as many pixels changes half as fast per pixel. At 4000px that is a p99
// near 11px and worst cases past a hundred — at 300dpi, flat steps a millimetre
// to a centimetre wide with a visible edge either side.
//
// Adding noise of about one least-significant bit before rounding replaces
// those steps with a grain finer than the eye resolves at print distance. The
// information is not lost; it moves from a staircase into the noise floor,
// which is where the eye stops seeing it.
//
// TRIANGULAR PDF, not uniform. The difference of two independent uniforms is
// triangular on [-1,1], and that specific shape is what makes the quantisation
// error's mean AND variance independent of the signal. Uniform dither of the
// same width fixes the mean but leaves the variance modulated by the signal,
// which reads as the noise "breathing" across a gradient — banding replaced by
// a softer artefact rather than removed.
//
// KEY IT ON THE GLOBAL PIXEL. Dither derived from a tile-local coordinate would
// make a tiled export differ from an untiled one, breaking the one invariant
// the whole export path exists to preserve. `test/export.test.ts` compares
// bytes and would catch it, which is exactly why the caller passes an absolute
// pixel rather than gl_FragCoord.

/**
 * Dither offset for a pixel, in display-space units.
 *
 * `lsb` is the size of one output step: 1/255 for 8-bit, 1/65535 for 16-bit,
 * zero to disable. It has to match the depth actually being written — dither
 * sized for 8 bits carried into a 16-bit file is 256 times too much noise, and
 * the file that was supposed to be cleaner is visibly grainier.
 *
 * Deliberately independent of time and of sample count: a paused frame refines
 * by accumulating more samples and resolving again, and dither that moved
 * between resolves would crawl while the picture converged.
 */
vec3 colDitherTpdf(vec2 pixel, float lsb) {
    // Two explicitly separate hash streams rather than one hash of two nearby
    // points: independence is the entire premise of the triangular shape.
    vec3 a = hash33(vec3(pixel, 0.0));
    vec3 b = hash33(vec3(pixel, 1.0));
    return (a - b) * lsb;
}

/**
 * Apply dither to an already display-encoded colour.
 *
 * AFTER the transfer function, never before. Quantisation happens in display
 * space, so that is the space the noise has to be one step wide in; dithering
 * in linear light would put wildly different amounts of noise into the shadows
 * and the highlights.
 */
vec3 colDither(vec3 displayColor, vec2 pixel, float lsb) {
    return displayColor + colDitherTpdf(pixel, lsb);
}

/** One step of an n-bit channel, for passing as `lsb`. */
float colLsbFor(int bits) {
    return 1.0 / (exp2(float(bits)) - 1.0);
}
