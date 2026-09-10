// 001 — Drift
//
// A twice-warped fbm field. The final height is almost incidental: lightness
// comes from the magnitude of the FIRST displacement, which varies on a much
// larger scale than the field itself and gives the image a structure above the
// noise floor. Colouring by the final value alone yields uniform mush.

// The display transform — exposure, tonemap, sRGB encode, dither — belongs to
// viz's resolve pass and is declared in meta.json. mainImage returns LINEAR
// RADIANCE and nothing else; values above 1 are meant to survive to be rolled
// off after the samples are averaged, not clamped inside each one.

#include "core/math.glsl"
#include "aa/edge.glsl"
#include "noise/fbm.glsl"
#include "color/palette.glsl"

uniform float uScale;    // @param 0.4 .. 3.0 = 1.25 "field scale"
uniform float uWarp;     // @param 0.0 .. 5.0 = 2.6 "warp amount"
uniform int   uOct;      // @param 1 .. 8 = 4 step 1 "octaves"
uniform float uDrift;    // @param 0.0 .. 0.2 = 0.01 "pan speed"
uniform float uFlow;     // @param 0.0 .. 1.2 = 0.26 "flow amount"
uniform float uFlowRate; // @param 0.0 .. 0.3 = 0.06 "flow rate"
uniform float uBlend;    // @param 0.0 .. 1.0 = 0.55 "height vs drift"

uniform vec3  uInk;      // @color = #0a0f1c "shadow"
uniform vec3  uMid;      // @color = #4f3375 "mid"
uniform vec3  uHot;      // @color = #fdcc78 "highlight"

uniform bool  uContours; // @toggle = true "contours"
uniform float uBands;    // @param 0.0 .. 40.0 = 14.0 "contour count"
uniform float uInkWidth; // @param 0.002 .. 0.3 = 0.12 "contour width"
uniform float uInkWeight;// @param 0.0 .. 1.0 = 0.75 "contour weight"

uniform float uVignette; // @param 0.0 .. 1.0 = 0.55 "vignette"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // Short side normalised to 1.0 — the same picture at 512px and at 8000px.
    vec2 p = artCoord(fragCoord);

    int oct = uQuality > 0 ? uOct + 2 : uOct;

    // uDrift PANS. It offsets the position every stage of the warp is evaluated
    // at, and a warp with one shared offset is exactly the un-offset warp
    // evaluated at the shifted point — a rigid slide of the picture and nothing
    // else. Measured before this was written: over nine seconds, 85-93% of
    // everything that changed on screen was accounted for by a single integer
    // shift, and the shift matched t/uScale to the pixel. Kept, small, because a
    // slow pan is a nice bias; it is not what makes the piece move.
    float pan = uTime * uDrift;

    // uFlow FLOWS, by giving the three stages of the warp offsets that differ
    // from each other. Two decisions here:
    //
    // CIRCLES, not linear drifts. An offset that travels never comes back, so
    // the composition eventually walks out of the frame and what is on screen at
    // the end is a different picture from the one that was framed. A circle stays
    // in the neighbourhood it started in, so the structure moves INSIDE a fixed
    // composition — the same reason 010 freezes its framing constants while the
    // map itself drifts.
    //
    // INCOMMENSURATE RATES. Three circles whose rates are in irrational ratios
    // never return to the same configuration together, so there is no cycle to
    // notice, even though each stage on its own is periodic.
    //
    // AMPLITUDE GROWS WITH DEPTH. q is the composition; moving it hard reshapes
    // the whole picture at once, which reads as wobble. The field being sampled
    // through the warp is fine detail and can move furthest.
    //
    // THE CIRCLES PASS THROUGH THE ORIGIN (`cos - 1`, not `cos`), so all three
    // offsets are zero at t = 0 and frame 0 is the un-flowed picture whatever
    // uFlow is. That is worth having — it makes `--preset still` and `uFlow = 0`
    // agree on frame 0 instead of being two different images — and it has a
    // price this repo has paid twice already: a knob that cannot act at frame 0
    // reads exactly like a dead knob to anything measuring there. Which is why
    // poster.frame is no longer 0; both the audit and the render suite take
    // their working frame from it.
    //
    // Each circle is also ROTATED by its own angle. Without that, all three
    // start moving in +y together, and a shared velocity is a translation — the
    // first second would pan before it flowed.
    float a = TAU * uTime * uFlowRate;
    vec2 ow = uFlow * 0.6 *             vec2(cos(a)         - 1.0, sin(a));
    vec2 ov = uFlow * 1.0 * (rot2(2.4) * vec2(cos(a * 1.618) - 1.0, sin(a * 1.618)));
    vec2 os = uFlow * 1.6 * (rot2(4.9) * vec2(cos(a * 2.618) - 1.0, sin(a * 2.618)));

    vec2 q, r;
    float f = nzWarp21(p * uScale + vec2(pan, -pan * 0.62), oct, uWarp, ow, ov, os, q, r);

    // Large-scale: how far the domain got dragged. This is the composition.
    //
    // The gains below are MEASURED, not chosen. Both used to undershoot: with
    // 1.5, length(q)'s p99 of 0.50 reached only 0.75, so `uBands` counted ten
    // contours where it promised fourteen; with 1.2, length(r) reached 0.60, so
    // the 1.25 at the top of the grain multiplier below was unreachable and the
    // picture could never be brighter than 0.93x its ramp colour. p99 of both is
    // 0.50, so both gains are 2.0. Fifth time in this repo that a ramp was wired
    // to a driver that never visits its far end.
    float drift = sat(length(q) * 2.0);
    // Medium-scale: the second displacement, for local variation.
    float grain = sat(length(r) * 2.0);
    // Fine-scale: the field itself, contrast-expanded off its narrow centre.
    float shade = sat(f * 2.2 + 0.5);

    // uInk/uMid/uHot arrive already linear — viz converts the sRGB hex in the
    // declaration on upload, so nothing here has to think about encoding.
    vec3 col = colRamp3(mix(shade, drift, uBlend), uInk, uMid, uHot);
    col *= mix(0.45, 1.25, grain);

    // Contours follow the composition, not the noise, so they read as contours
    // rather than as texture.
    //
    // uInkWidth is a fraction of the band spacing — a DOMAIN width, not a pixel
    // count. This piece used to ask for lines "one pixel wide", which meant its
    // ink coverage fell as the output grew: the render suite measured the whole
    // image 1.76/255 darker at 300px than at 900px, and a 4000px print would
    // have come out with contours nobody chose. basics/aa exists because of it.
    //
    // The defaults were 0.035 half-width at weight 0.5: 7% of the drift axis,
    // darkened by a third. Turning the ENTIRE subsystem off measured 1.10/255,
    // which is why the audit read uBands (1.25), uInkWeight (1.09) and uContours
    // (1.07) as knobs that never reach the image. They were never broken — there
    // was simply nothing for them to scale. The hint was sitting in the same
    // table: uInkWidth, the one knob of the four that was actually doing work,
    // was also the highest of the four at 3.25. 0.12 / 0.75 was picked off a 3x3
    // sheet at the poster frame, and turning the subsystem off now measures 14.5.
    if (uContours) {
        float bands = drift * uBands;
        float line  = aaBand(aaRepeat(bands + 0.5), uInkWidth, aaFootprint(bands));
        col = mix(col, col * 0.35, line * uInkWeight);
    }

    // Vignette in art space, not pixel space.
    col *= 1.0 - uVignette * sat(dot(p, p) * 1.05);

    fragColor = vec4(col, 1.0);
}
