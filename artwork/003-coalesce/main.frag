// 003 — Coalesce · image pass
//
// Reads the reaction-diffusion field and lights it as a relief rather than
// colouring it as a heatmap — the gradient of B becomes a surface normal, which
// is what turns a chemical concentration into something that looks like a
// physical object.
//
// The simulation runs on a fixed grid, not a fraction of the output. The
// pattern scale is set by the grid: a larger grid is a DIFFERENT picture, not a
// sharper one, so tying it to the window would mean resizing the window changes
// the artwork. Detail for print comes from here instead — bilinear
// reconstruction of the field plus procedural grain evaluated at full
// resolution. This is the print strategy for every stateful piece in the repo.

#include "core/math.glsl"
#include "noise/fbm.glsl"
#include "color/palette.glsl"
#include "color/tonemap.glsl"

uniform sampler2D uField;  // @buffer a "chemical field"

uniform float uContrast;  // @param 0.5 .. 6.0 = 2.4 "contrast"
uniform float uBias;      // @param -0.5 .. 0.5 = -0.06 "bias"
uniform float uRelief;    // @param 0.0 .. 3.0 = 1.15 "relief"
uniform float uLightYaw;  // @param -3.15 .. 3.15 = -0.9 "light yaw"
uniform float uSheen;     // @param 0.0 .. 2.0 = 0.7 "sheen"

uniform vec3  uInk;       // @color = #10131c "shadow"
uniform vec3  uMid;       // @color = #3c6b7a "mid"
uniform vec3  uHot;       // @color = #f2e6c8 "highlight"

uniform float uGrain;     // @param 0.0 .. 1.0 = 0.22 "grain"
uniform float uGrainScale;// @param 4.0 .. 200.0 = 64.0 "grain scale"
uniform float uVignette;  // @param 0.0 .. 1.0 = 0.4 "vignette"
uniform float uExposure;  // @param -2.0 .. 2.0 = 0.15 "exposure"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = paUv(fragCoord);
    vec2 p = artCoord(fragCoord);

    float b = paBilinear(uField, uv).y;

    // Gradient step: one output pixel, but never finer than the simulation can
    // actually resolve. Bilinear reconstruction is only C0, so differencing it
    // below one texel returns the piecewise-constant derivative and stamps the
    // simulation grid across a large print. Clamping keeps the relief
    // resolution-independent above that floor.
    float e = max(pxSize(), 0.7 / float(textureSize(uField, 0).y));
    float bx = paBilinear(uField, uv + vec2(e, 0.0)).y
             - paBilinear(uField, uv - vec2(e, 0.0)).y;
    float by = paBilinear(uField, uv + vec2(0.0, e)).y
             - paBilinear(uField, uv - vec2(0.0, e)).y;

    vec3 n = normalize(vec3(-bx, -by, e * 2.0 / max(uRelief, 1e-3)));
    vec3 l = normalize(vec3(cos(uLightYaw), sin(uLightYaw), 0.85));

    float diffuse = sat(dot(n, l) * 0.5 + 0.5);
    float spec = pow(sat(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0))), 28.0) * uSheen;

    float shade = sat((b + uBias) * uContrast);
    vec3 col = colRamp3(shade, uInk, uMid, uHot);
    col *= 0.35 + 0.9 * diffuse;
    col += spec * mix(uMid, uHot, 0.6);

    // Grain at display resolution — the other half of recovering print detail
    // from a small simulation.
    float grain = nzFbm21(uv * uGrainScale, 4) * 0.5 + 0.5;
    col *= mix(1.0, 0.55 + 0.9 * grain, uGrain);

    col *= 1.0 - uVignette * sat(dot(p, p) * 1.1);

    col = colTonemapAces(colExposure(col, uExposure));
    fragColor = vec4(col, 1.0);
}
