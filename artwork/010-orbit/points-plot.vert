// 010 — Orbit, scatter pass
//
// The repo's first pass that SCATTERS. Every other pass in every other piece is
// a fullscreen triangle where each fragment asks "what is at me?"; this one is
// N points that each say "I go here". A strange attractor is the clearest case
// for why the distinction is not a matter of taste: the picture is the
// attractor's invariant measure — where orbits spend their time — and there is
// no function of position that returns it. A pixel could only find out by
// running every orbit, which is the whole computation done once per pixel.
//
// HOW IT REFINES. Each frame plots `count` fresh orbits, seeded from the point
// index AND the frame, so frame N has deposited N x count of them. The
// accumulation lives downstream in buffer-accum.frag, which reads itself; this
// pass only ever contributes one frame's worth. That split is deliberate — a
// scatter pass that quietly accumulated into an uncleared target would work
// exactly once and then be impossible to reason about, because "how many points
// are in this picture" would depend on how many times the chain happened to run.
//
// The transient is what makes it an attractor plot rather than a picture of the
// starting distribution: the first several iterates still remember where they
// began, so they are iterated and thrown away, and only the settled position is
// deposited.

#include "core/math.glsl"
#include "hash/hash.glsl"
#include "attract/maps.glsl"

uniform vec4  uK;        // @param -3.0 .. 3.0 = 1.4,1.56,1.4,-2.56 "attractor"
uniform int   uMap;      // @enum 2:svensson 0:deJong 1:clifford "attractor map"
uniform int   uWarm;     // @param 2 .. 40 = 14 step 1 "transient"
uniform float uZoom;     // @param 0.15 .. 1.4 = 0.440 "zoom"
uniform vec2  uPan;      // @param -0.8 .. 0.8 = 0.0,0.010 "pan"
uniform float uWeight;   // @param 0.02 .. 2.0 = 0.35 "deposit weight"
uniform float uSpread;   // @param 0.0 .. 1.0 = 0.55 "colour spread"

// FLOW: how far the map's own constants wander, and how fast.
//
// Without this the piece converges and then stops. Every frame plots fresh
// orbits of the SAME map, so after a few hundred frames the estimate of the
// invariant measure stops visibly improving and the remaining 900 frames of the
// twenty-second video are the same picture repeated. The subject was "where
// orbits spend their time" for one fixed map; with a drift it becomes how that
// measure DEFORMS as the map changes, which is a thing that can only be shown
// as a moving image and is the better use of the format.
//
// Paired with `uDecay` below 1, which is what gives the picture a finite
// memory: the accumulator then holds roughly 1/(1-uDecay) frames, so the
// structure is a moving average of the recent maps rather than of all of them.
// The two have to be tuned together — a drift fast enough to see inside the
// memory window smears the filaments into fog, which is the failure mode.
//
// The frequencies are deliberately incommensurate, so the four constants never
// return to the same configuration together and the piece does not visibly
// repeat.
uniform float uFlow;     // @param 0.0 .. 0.6 = 0.22 "flow"
uniform float uFlowRate; // @param 0.02 .. 1.0 = 0.16 "flow rate"

/** The map's constants at this instant. Equals uK exactly when uFlow is 0. */
vec4 orbitK() {
    float t = uTime * uFlowRate;
    return uK + uFlow * vec4(sin(t), cos(t * 1.31), sin(t * 0.73 + 1.7), cos(t * 1.17 + 0.4));
}

vec2 orbitStep(vec2 p, vec4 k) {
    if (uMap == 1) return atrClifford(p, k);
    if (uMap == 2) return atrSvensson(p, k);
    return atrDeJong(p, k);
}

/**
 * The extent the map can reach, from `basics/attract`'s analytic bounds rather
 * than a hand-tuned zoom — which is what lets the piece frame the WHOLE
 * attractor when the parameters change. Cropping an attractor looks like a
 * different and worse attractor, and the crop is invisible as a cause.
 *
 * It deliberately uses the BASE constants rather than the drifting ones.
 *
 * The bound is what the position is divided by, so recomputing it from the
 * moving constants would renormalise the picture every frame: the attractor
 * would pulse in size as it morphed, and with a trail behind it that pulse
 * smears every filament radially. Freezing the frame to uK means the structure
 * moves WITHIN a fixed window, which is what makes the motion readable. The cost
 * is that a large uFlow can push the attractor past the window it was framed
 * for, which is why uFlow stops at 0.6 rather than at the parameter range.
 */
vec2 orbitExtent() {
    if (uMap == 1) return atrCliffordBound(uK);
    if (uMap == 2) return atrSvenssonBound(uK);
    return vec2(atrDeJongBound(uK));
}

void mainPoint(int index, out vec2 pos, out float size, out vec4 deposit) {
    // A fresh start per point AND per frame. Without the frame in the hash
    // every frame replots the identical orbits and the picture stops refining
    // after the first one — it just gets brighter, which looks like progress
    // and is not.
    vec2 seed = vec2(float(index), float(uFrame) * 7.13 + float(uSeed) * 3.77);
    vec2 p = (hash22(seed) * 2.0 - 1.0) * orbitExtent();
    vec4 k = orbitK();

    // The transient, discarded. An orbit's first iterates still remember the
    // uniform distribution it started from, so plotting them would lay a
    // rectangle of haze over the attractor.
    for (int i = 0; i < 40; ++i) {
        if (i >= uWarm) break;
        p = orbitStep(p, k);
    }

    // Speed along the orbit, used as the colour driver. It varies continuously
    // over the attractor — fast where the map stretches, slow where orbits
    // linger — which is exactly what a ramp needs, and it is free because the
    // next iterate has to be computed anyway to have it.
    vec2 q = orbitStep(p, k);
    float speed = sat(length(q - p) / max(length(orbitExtent()), 1.0e-3) * 3.0);

    // Pan, because an attractor is not centred on the origin and nothing here
    // can find out where it IS: the centroid is a reduction over every orbit,
    // and a vertex shader sees one point. The analytic bounds frame the region
    // the map can reach, which is a box the attractor sits somewhere inside —
    // so the leftover offset is a framing decision and belongs on a knob.
    pos = p / max(max(orbitExtent().x, orbitExtent().y), 1.0e-3) * uZoom + uPan;
    size = 1.0;
    // Escaped orbits deposit nothing. atrEscaped is written so that NaN counts
    // as escaped: one NaN additively blended into a float target poisons that
    // texel for the whole frame, and NaN survives every later average.
    float live = atrEscaped(p, 1.0e3) ? 0.0 : 1.0;
    deposit = vec4(uWeight * live, uWeight * live * mix(1.0, speed, uSpread), 0.0, live);
}
