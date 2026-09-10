#pragma once
#include "core/math.glsl"
#include "color/spaces.glsl"

// The colour of something at a temperature.
//
// FORCED BY THE DOPPLER SHIFT, not chosen. 012 needed to move a sky's colour by
// a factor D, and a shift is an operation on a SPECTRUM — an RGB triple has
// nothing to shift. The cheapest honest spectrum is a Planck curve, and it has
// the property that makes the whole thing collapse to one multiply: scaling
// every frequency of a blackbody at T by D gives exactly a blackbody at D*T.
// So the artwork's colour knob becomes a temperature, the relativistic shift
// becomes `T * D`, and no spectral sampling loop is needed anywhere.
//
// THE TRAP, and it is a big one: a blackbody's total radiance already goes as
// T^4, and the relativistic beaming factor IS that same D^4. Apply both and the
// front of the sky comes out eight times too bright at beta = 0.5 with no sign
// in the picture that anything is wrong. So `colBlackbody` returns a colour
// NORMALISED TO UNIT Rec.709 LUMINANCE — a chromaticity, carrying no brightness
// at all — and every bit of the brightness comes from `relBeam` and the piece's
// own field. The normalisation is exact by construction and the test checks it,
// because it is the single line standing between the two conventions.

/** Loop bound: GLSL ES 3.0 wants a constant trip count. */
const int COL_BB_MAX = 64;

/**
 * Planck's law, up to a constant factor, at `lambdaNm` nanometres.
 *
 * Evaluated in micrometres internally: lambda^5 in nanometres is around 1e13,
 * which multiplied by the exponential leaves the result within a couple of
 * orders of the smallest normal float. In micrometres nothing gets near the
 * ends of the range. Only ratios matter here, so the missing constants are free.
 */
float colPlanck(float lambdaNm, float kelvin) {
    float um = lambdaNm * 1.0e-3;
    float um2 = um * um;
    float um5 = um2 * um2 * um;
    // hc/k in micrometre-kelvin.
    float x = 14387.7 / (um * max(kelvin, 1.0));
    // exp() overflows to infinity below roughly 600 K at the blue end, and that
    // is the right answer rather than a problem: 1/inf is zero, which is what
    // a cold body emits there. No NaN can form, so nothing needs clamping away.
    return 1.0 / (um5 * (exp(x) - 1.0));
}

/**
 * The CIE 1931 colour matching functions, as multi-lobe Gaussians.
 *
 * Wyman, Sloan & Shirley, "Simple Analytic Approximations to the CIE XYZ Colour
 * Matching Functions" (JCGT 2013). Each lobe is a Gaussian with a different
 * width either side of its peak, which is what lets three of them stand in for
 * a tabulated curve. Accurate enough that a 6504 K body comes out within 4% of
 * neutral on all three channels — checked in the test against that anchor,
 * since a transposed coefficient here would still produce a smooth plausible
 * ramp of colours that is simply the wrong ramp.
 */
vec3 colCieXyz(float lambdaNm) {
    // A lobe: Gaussian with a different sigma below and above its peak.
    float t1 = (lambdaNm - 599.8) * (lambdaNm < 599.8 ? 1.0 / 37.9 : 1.0 / 31.0);
    float t2 = (lambdaNm - 442.0) * (lambdaNm < 442.0 ? 1.0 / 16.0 : 1.0 / 26.7);
    float t3 = (lambdaNm - 501.1) * (lambdaNm < 501.1 ? 1.0 / 20.4 : 1.0 / 26.2);
    float x = 1.056 * exp(-0.5 * t1 * t1) + 0.362 * exp(-0.5 * t2 * t2)
            - 0.065 * exp(-0.5 * t3 * t3);

    float t4 = (lambdaNm - 568.8) * (lambdaNm < 568.8 ? 1.0 / 46.9 : 1.0 / 40.5);
    float t5 = (lambdaNm - 530.9) * (lambdaNm < 530.9 ? 1.0 / 16.3 : 1.0 / 31.1);
    float y = 0.821 * exp(-0.5 * t4 * t4) + 0.286 * exp(-0.5 * t5 * t5);

    float t6 = (lambdaNm - 437.0) * (lambdaNm < 437.0 ? 1.0 / 11.8 : 1.0 / 36.0);
    float t7 = (lambdaNm - 459.0) * (lambdaNm < 459.0 ? 1.0 / 26.0 : 1.0 / 13.8);
    float z = 1.217 * exp(-0.5 * t6 * t6) + 0.681 * exp(-0.5 * t7 * t7);

    return vec3(x, y, z);
}

/**
 * Linear sRGB of a blackbody at `kelvin`, NORMALISED TO UNIT LUMINANCE.
 *
 * `samples` is the midpoint-rule resolution over 390-740 nm. 32 is within
 * 6.3e-3 per channel of a 512-sample integral across 1200 K to 40000 K, which
 * is far below anything the eye or an 8-bit output can hold, and the test pins
 * that convergence so the count can be lowered later on evidence rather than
 * on nerve.
 *
 * Negative channels are clamped: a saturated Planckian red is outside the sRGB
 * gamut, so the blue channel comes back slightly negative before clamping and
 * would otherwise subtract light from whatever it multiplies.
 */
vec3 colBlackbody(float kelvin, int samples) {
    float lo = 390.0;
    float hi = 740.0;
    int n = clamp(samples, 4, COL_BB_MAX);
    float h = (hi - lo) / float(n);
    vec3 xyz = vec3(0.0);
    for (int i = 0; i < COL_BB_MAX; ++i) {
        if (i >= n) break;
        float lam = lo + h * (float(i) + 0.5);
        xyz += colPlanck(lam, kelvin) * colCieXyz(lam);
    }
    vec3 rgb = max(colXyzToLinear(xyz), vec3(0.0));
    // The whole point: strip the brightness, keep the hue. See the note above
    // about T^4 and D^4 being the same factor.
    return rgb / max(colLumaLinear(rgb), 1.0e-20);
}

vec3 colBlackbody(float kelvin) { return colBlackbody(kelvin, 32); }
