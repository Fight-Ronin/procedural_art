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
uniform float uDrift;    // @param 0.0 .. 0.2 = 0.04 "drift speed"
uniform float uBlend;    // @param 0.0 .. 1.0 = 0.55 "height vs drift"

uniform vec3  uInk;      // @color = #0a0f1c "shadow"
uniform vec3  uMid;      // @color = #4f3375 "mid"
uniform vec3  uHot;      // @color = #fdcc78 "highlight"

uniform bool  uContours; // @toggle = true "contours"
uniform float uBands;    // @param 0.0 .. 40.0 = 14.0 "contour count"
uniform float uInkWidth; // @param 0.002 .. 0.2 = 0.035 "contour width"
uniform float uInkWeight;// @param 0.0 .. 1.0 = 0.5 "contour weight"

uniform float uVignette; // @param 0.0 .. 1.0 = 0.55 "vignette"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // Short side normalised to 1.0 — the same picture at 512px and at 8000px.
    vec2 p = artCoord(fragCoord);

    float t = uTime * uDrift;
    int oct = uQuality > 0 ? uOct + 2 : uOct;

    vec2 q, r;
    float f = nzWarp21(p * uScale + vec2(t, -t * 0.62), oct, uWarp, q, r);

    // Large-scale: how far the domain got dragged. This is the composition.
    float drift = sat(length(q) * 1.5);
    // Medium-scale: the second displacement, for local variation.
    float grain = sat(length(r) * 1.2);
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
    if (uContours) {
        float bands = drift * uBands;
        float line  = aaBand(aaRepeat(bands + 0.5), uInkWidth, aaFootprint(bands));
        col = mix(col, col * 0.35, line * uInkWeight);
    }

    // Vignette in art space, not pixel space.
    col *= 1.0 - uVignette * sat(dot(p, p) * 1.05);

    fragColor = vec4(col, 1.0);
}
