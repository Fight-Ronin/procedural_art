// 013 — Shoal, accumulation pass
//
// The same shape as 010's, and for the same reason: a scatter pass that blended
// into an uncleared target would make "how many photons are in this picture"
// depend on how many times the chain happened to run, which is not a question a
// still, a tile, a sequence resume and a live preview can all answer the same
// way.
//
// .rgb is spectral weight and .a is the photon count. They accumulate together
// so the ratio stays meaningful at every texel.

#include "core/math.glsl"

uniform sampler2D uDeposit;  // @buffer splat "this frame's photons"
uniform sampler2D uHist;     // @buffer accum "everything so far"

// RETENTION IS BACK, AND IT ONLY MEANS ANYTHING BECAUSE THE SURFACE MOVES.
//
// The fbm version had no retention knob and was right not to: the surface was
// fixed, so every frame was another Monte Carlo sample of the SAME picture and
// forgetting could only add variance. The render suite reported it as a dead
// parameter, mean delta 0.00 — which is exactly what a knob that cancels
// against its own normalisation looks like.
//
// With travelling waves the accumulator is integrating over a MOVING surface,
// so its memory is a shutter time. Long memory averages several seconds of sea
// into a smooth net; short memory tracks the instant and is noisier. That is a
// real exposure decision and it belongs on a knob — the same tension 010 has
// between its drift rate and its memory, arrived at from the other direction.
//
// The still preset keeps everything (retention 1) and lets the noise integrate
// away, because a print has no shutter.

uniform float uDecay;        // @param 0.70 .. 1.0 = 0.93 "shutter (retention)"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    ivec2 c = ivec2(fragCoord);
    vec4 add = texelFetch(uDeposit, c, 0);
    vec4 prev = uInit == 1 ? vec4(0.0) : texelFetch(uHist, c, 0) * uDecay;
    fragColor = prev + add;
}
