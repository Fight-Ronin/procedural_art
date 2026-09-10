// 013 — Shoal
//
// Caustics: the bright network on a pool floor. A wavy surface deflects each
// ray by the gradient of its phase, and what you see is where the rays pile up.
//
// The floor is a WEDGE. `a` — distance and relief folded into one number —
// grows from left to right, and the caustic appears where it reaches the local
// focal length, so a single frame holds the whole one-parameter unfolding:
// smooth, first folds, cusps, tangle. That is the subject. A caustic at one
// fixed distance is a picture of a member; this is a picture of the family.
//
// WHY THE INTENSITY NEEDS NO FORMULA. Flux conservation makes it
// `sum over preimages of 1 / |det J|`, which is infinite on the caustic and
// needs root-finding everywhere else. The scatter pass evaluates neither: the
// photons that land ARE the density. `basics/optics/lens.glsl` still carries
// det J, because its sign and its zero say where the folds are — but nothing
// in the picture divides by it.
//
// THE DYNAMIC RANGE IS THE POINT AND THE PROBLEM. Near a fold the intensity
// goes as one over the square root of the distance to it, so the folds carry
// tens of times what the shadowed cells between them do. Linear tone shows the
// network and a black page; an exposure that opens the cells welds the network
// into a slab. The log curve is the same answer 010 needed for the same reason.

#include "core/math.glsl"
#include "color/palette.glsl"
#include "color/spaces.glsl"

uniform sampler2D uHist;   // @buffer accum "accumulated photons"

// Declared here AND in buffer-accum.frag, identically — the accumulation pass
// applies the retention and this pass has to divide by the series it produces.
// `mergeParams` keeps the first of two same-named specs, so a differing range
// or default would be taken silently from whichever module loads first.
uniform float uDecay;      // @param 0.70 .. 1.0 = 0.93 "shutter (retention)"

uniform float uGain;       // @param 0.5 .. 400.0 = 60.0 "density gain"
uniform float uGamma;      // @param 0.3 .. 2.0 = 0.85 "density curve"
uniform float uWhite;      // @param 0.02 .. 4.0 = 0.33 "white point"
// THE PALETTE IS THE FLOOR, NOT THE WATER — a division of labour that only
// became possible once the splat pass started absorbing light.
//
// Before that, the ramp had to carry every colour in the picture, so it ran
// teal to cream and the water's blue was painted on. Now the blue is COMPUTED:
// each photon is attenuated per wavelength along the depth above where it
// lands, so the deep end loses its red and the shallow end does not. Leaving
// the ramp teal as well then fought the physics — the warm caustic highlights
// went blue with everything else and the frame turned monochrome.
//
// So these three are pale tile in sun, pale tile lit, and pale tile in shadow.
// Every hue in the output comes from the two dispersions: the water's, which
// makes depth blue, and the light's, which puts the fringes on the folds.
uniform vec3  uPalA;       // @color = #070a0e "shadowed floor"
uniform vec3  uPalB;       // @color = #7d7a70 "lit floor"
uniform vec3  uPalC;       // @color = #fff6e2 "caustic"
uniform float uChroma;     // @param 0.0 .. 2.0 = 1.15 "dispersion tint"
uniform float uVignette;   // @param 0.0 .. 1.0 = 0.18 "vignette"

/**
 * Density to colour.
 *
 * OPEN: THIS PIECE DOES NOT YET PASS `013 is resolution independent`.
 * Best measured configuration is 5.37/255 mean against a bound of 3, with the
 * overall level at 0.66 against a bound of 1. The number is recorded here
 * rather than legislated away, and so is what it is NOT — five hypotheses, four
 * of them killed by measurement:
 *
 *   * point sampling instead of filtering — real, and the box filter above took
 *     it from 10.80 to 7.86;
 *   * a coarser reconstruction filter — going from 25 taps to 100 moved it to
 *     7.72, so the filter is not the residual;
 *   * Monte Carlo noise — four times the photons moved it to 7.64, so it is not
 *     variance;
 *   * a grid too fine for the output — a coarser grid with a proportionally
 *     smaller splat made it WORSE, at 6.43;
 *   * applying the tone curve at grid scale and filtering after it — better in
 *     the mean, at 5.42, and much worse in the level, at 4.73. Not it either;
 *   * the surface model — replacing fbm with a dispersive sum of gravity waves,
 *     a completely different field with completely different statistics, moved
 *     the mean by 0.23 (5.37 to 5.60). THIS IS THE STRONGEST ONE. Whatever the
 *     residual is, it does not care what makes the surface.
 *
 * The one lever that works is the splat width: 7.86 at 2.5 texels, 5.37 at 4.2,
 * 4.24 at 6.0 on the fbm surface, and 5.60 -> 4.85 going from 4.2 to 5.2 on the
 * wave one — where the OVERALL LEVEL went the other way, 1.00 to 1.63, so even
 * that lever does not buy both metrics at once. That is the tell. A caustic is a SINGULAR image — the intensity
 * diverges as one over the square root of the distance to a fold — so it has
 * structure at every scale, and the splat is the only thing bandlimiting it.
 * The concave tone curve cannot commute with an average of a field that is not
 * bandlimited to the pixel, so the metric can only be bought with blur, and
 * blur is the subject here.
 *
 * That makes this a question about what the piece IS rather than a tolerance to
 * tune, which is why it is written down and left open.
 */
vec3 shoalShade(float density, vec4 h) {
    // AN EXPLICIT WHITE POINT. `log(1 + g d) / log(1 + g)` normalises against
    // the curve's value at d = 1, so it only maps into [0,1] when the density
    // cannot exceed one. 011 shipped without this and both of its tone knobs
    // read as dead, because a saturated map looks exactly like a map nothing is
    // connected to. Photon density per texel has no reason to be near one.
    float tone = safePow(log(1.0 + uGain * density / uWhite) / log(1.0 + uGain), uGamma);

    vec3 col = colRamp3(tone, uPalA, uPalB, uPalC);

    // THE DISPERSION TINT IS A RATIO, so it is a colour rather than a
    // brightness: the spectral weights are normalised to integrate to white, so
    // this is neutral wherever the wavelengths arrived together and coloured
    // only where the map separated them — which is to say, only on the folds.
    // Multiplying the ramp by it keeps the ramp in charge of tone; adding it
    // would let the fringes brighten the picture and hide in the exposure.
    if (h.a > 1.0e-6) {
        vec3 chroma = h.rgb / h.a;
        float y = max(colLumaLinear(chroma), 1.0e-4);
        col *= mix(vec3(1.0), chroma / y, uChroma);
    }
    return col;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // RECONSTRUCTION IS A FILTER, NOT A LOOKUP, AND ITS WIDTH IS THE OUTPUT
    // PIXEL. The deposit grid is absolutely sized — 900 texels on the short
    // side, whatever the output — so an output smaller than that is asking for
    // an AVERAGE of several grid texels, and a bilinear tap gives it a sample
    // instead. A caustic filament is one or two texels wide, so the sample and
    // the average are very different numbers.
    //
    // This is what `013 is resolution independent` measured, at 10.80/255 mean
    // against a bound of 3, with the overall level off by 2.16: a 200px render
    // was point-sampling a 900px field and the aliasing does not wash out under
    // downsampling, because it happened before the downsample. Every other
    // stateful piece here got away with a single bilinear tap because its field
    // is smooth on the scale of a texel; this one's is not, by construction.
    //
    // The tap count follows the ratio of grid to output, so the print path —
    // where the output is finer than the grid — costs exactly one tap and gets
    // ordinary bilinear. The cap is a budget: past five taps the piece is being
    // previewed so small that the difference no longer shows.
    vec2 gres = vec2(textureSize(uHist, 0));
    float ratio = max(gres.x / uFullRes.x, gres.y / uFullRes.y);
    // The cap is a budget, measured: going from 25 taps to 100 moved the metric
    // by 0.14/255, so past five there is nothing left to buy.
    int taps = clamp(int(ceil(ratio)), 1, 5);

    vec4 h = vec4(0.0);
    for (int j = 0; j < taps; ++j) {
        for (int i = 0; i < taps; ++i) {
            // A box over exactly one output pixel, sampled on a regular grid.
            vec2 o = (vec2(float(i), float(j)) + 0.5) / float(taps) - 0.5;
            h += paBilinear(uHist, paUv(fragCoord) + o / uFullRes);
        }
    }
    h /= float(taps * taps);

    // EFFECTIVE frames, not elapsed frames. The accumulator keeps `uDecay` of
    // itself each step, so it holds a geometric series; dividing by the frame
    // count is only right at retention exactly 1, and below that the picture
    // fades at a rate nobody chose. 010 shipped with that bug — measured at
    // r = 0.95, falling 64.5 to 59.0 to 48.3 across frames 12, 40 and 120 — and
    // it was the fifth normalisation in this repo to have assumed a
    // configuration, so the closed form is copied here rather than rediscovered.
    // It degrades to the frame count as r approaches 1, and the guard is
    // numerical: the ratio loses its significant digits in float32 once r is
    // within a thousandth of one.
    float frames = float(uFrame) + 1.0;
    float eff = uDecay > 0.999
        ? frames
        : (1.0 - pow(uDecay, frames)) / (1.0 - uDecay);
    vec3 col = shoalShade(h.a / eff, h);

    vec2 p = artCoord(fragCoord);
    col *= 1.0 - uVignette * sat(dot(p, p) * 1.6);

    fragColor = vec4(max(col, 0.0), 1.0);
}
