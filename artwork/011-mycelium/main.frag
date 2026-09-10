// 011 — Mycelium
//
// Jeff Jones' slime-mould model: a few hundred thousand agents that sense a
// trail map ahead of themselves, turn, move, and deposit; the map decays and
// diffuses. Nobody tells the agents to build a network and they build one, in
// which paths that carry traffic are reinforced and paths that stop being used
// evaporate. It is the piece the scatter pass exists for.
//
// FOUR PASSES, AND THE ORDER IS THE ALGORITHM:
//
//   agents   (buffer) sense last step's trail, turn, move          reads itself
//   deposit  (points) each agent drops a texel where it now is     reads agents
//   trail    (buffer) decay + diffuse, then add the deposit        reads both
//   main     (image)  read the trail and colour it
//
// Every one of those relationships is the chain's ordinary semantics — a pass
// reading an earlier pass sees the current step, a pass reading itself or a
// later one sees the previous. Nothing here is a special case, which is the
// whole return on having built the point pass as a chain pass.
//
// The trail map is the state and it is absolutely sized, so this piece prints
// the way 003 does: the simulation runs at a fixed sensible grid and the image
// pass recovers smoothness above it. A network at 4000px is the same network as
// the preview, resolved better — not a finer network, which is what tying the
// grid to the output would have given.

#include "core/math.glsl"
#include "color/palette.glsl"
#include "aa/edge.glsl"

uniform sampler2D uTrail;   // @buffer trail "trail map"

uniform float uWhite;       // @param 0.5 .. 120.0 = 5.0 "white point"
uniform float uGain;        // @param 0.2 .. 30.0 = 10.0 "density gain"
uniform float uGamma;       // @param 0.25 .. 2.0 = 0.80 "density curve"
uniform vec3  uBack;        // @color = #0b0e14 "background"
uniform vec3  uLow;         // @color = #1f5f6e "faint"
uniform vec3  uMid;         // @color = #7fd4c1 "network"
uniform vec3  uHot;         // @color = #fff3d0 "trunk"
uniform float uPhase;       // @param 0.0 .. 1.2 = 0.45 "phase tint"
uniform float uSharp;       // @param 0.0 .. 1.0 = 0.55 "edge sharpening"
uniform float uVignette;    // @param 0.0 .. 1.0 = 0.35 "vignette"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = paUv(fragCoord);
    vec4 t = paBilinear(uTrail, uv);

    // log, for the same reason 010 needs it: a trail map spans decades between
    // a trunk and the haze around it, and a linear map shows one or the other.
    //
    // THE WHITE POINT IS EXPLICIT, and it has to be. The obvious normalisation
    // is log(1 + g*d) / log(1 + g), which is what 010 uses — but that divisor
    // is the value the curve reaches at d = 1, so it only maps to [0,1] if the
    // density never exceeds 1. In 010 it does not: the accumulator is divided
    // by the frame count first. Here the trail is a running total against a
    // decay, so its steady state is deposit/(1 - retention) — of order twenty,
    // not one. Every network texel therefore landed far past white, both knobs
    // pushed it further past white, and a 3x3 sweep of gain against gamma came
    // back with nine identical cells. That is what a saturated mapping looks
    // like from the outside: not "too bright" but "nothing does anything".
    float d = t.r / max(uWhite, 1.0e-3);
    float tone = safePow(sat(log(1.0 + uGain * d) / log(1.0 + uGain)), uGamma);

    // Unsharp mask against a wider read of the same field. The trail is a
    // diffused quantity, so it is soft by construction; subtracting a blurrier
    // copy puts the edge back without inventing detail that is not in the
    // simulation. The offset is in TRAIL TEXELS, not output pixels, so the
    // sharpening is the same at preview and print size — an output-pixel offset
    // would sharpen a 400px preview and do nothing at all at 4000px.
    vec2 texel = 1.0 / vec2(textureSize(uTrail, 0));
    float wide = 0.25 * (
        paBilinear(uTrail, uv + vec2( texel.x * 2.0, 0.0)).r +
        paBilinear(uTrail, uv + vec2(-texel.x * 2.0, 0.0)).r +
        paBilinear(uTrail, uv + vec2(0.0,  texel.y * 2.0)).r +
        paBilinear(uTrail, uv + vec2(0.0, -texel.y * 2.0)).r);
    float wideTone = safePow(
        sat(log(1.0 + uGain * wide / max(uWhite, 1.0e-3)) / log(1.0 + uGain)), uGamma);
    tone = sat(tone + (tone - wideTone) * uSharp);

    // Deposit-weighted mean phase: G accumulated as deposit * phase, so the
    // ratio is an average over the agents that actually passed through here.
    // A phase read from position instead would paint a fixed pattern the
    // network happens to lie on top of, which is the 001 mistake in another
    // costume — the colour has to come from the process, not from the place.
    float phase = t.r > 1.0e-5 ? sat(t.g / t.r) : 0.0;

    vec3 col = colRamp3(sat(tone * 1.6), uBack, uLow, uMid);
    col = mix(col, uHot, sat((tone - 0.62) / 0.38));
    col = mix(col, col * vec3(1.18, 0.94, 0.78), phase * uPhase * tone);

    vec2 a = artCoord(fragCoord);
    col *= 1.0 - uVignette * sat(dot(a, a) * 1.5);

    fragColor = vec4(col, 1.0);
}
