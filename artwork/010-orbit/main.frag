// 010 — Orbit
//
// A strange attractor plotted by scatter: N orbits per frame, each iterated
// past its transient and deposited where it lands, accumulated across frames.
// The picture is the map's invariant measure — where orbits spend their time.
//
// AND IT MOVES. The map's own constants drift (`uFlow` in the scatter pass), so
// the subject is not one measure but how a measure DEFORMS as its map changes —
// filaments splitting, a caustic gathering and dissolving, the ring thickening.
// That is a thing only a moving image can show, and it is what the piece's
// twenty seconds of video are now for; before, every frame after the first few
// hundred was the same converged picture repeated.
//
// The accumulator's retention is what makes that legible rather than a smear:
// it holds roughly 1/(1-uDecay) frames, so the image is a moving average over
// the recent maps. Print wants the opposite — `--preset still` turns the drift
// off and the retention to 1, which is the converged plot of a single map.
//
// This is the piece the point pass was built for, and it was chosen as the
// first one because it is the SIMPLEST thing that cannot be written as a
// gather. There is no field to sample: no function of position returns the
// density, only a great many points that land. Physarum needs the same
// machinery plus an agent state buffer; this needs the machinery and nothing
// else, so if it works the machinery works.
//
// THE DENSITY IS READ LOGARITHMICALLY. An attractor's measure spans several
// decades — the dense filaments carry hundreds of times what the tails do — so
// a linear map shows the filaments and nothing else, and an exposure that
// reveals the tails blows the filaments to a white slab. log(1 + k*d) is the
// standard answer and it is standard because it is right: it compresses decades
// into a range an eye can hold while leaving the ordering intact.
//
// The count divisor is what makes it resolution- and time-independent. The
// accumulation grows as frames pass, so the image pass divides by how much went
// in; without that, "how bright is this piece" would be "how long have you been
// watching". With retention below 1 the right divisor is not the frame count —
// see `eff` below, which is the whole reason the piece can be shown moving.

#include "core/math.glsl"
#include "color/palette.glsl"

uniform sampler2D uHist;   // @buffer accum "accumulated orbits"

// Declared here AND in buffer-accum.frag, identically. The accumulation pass
// applies the retention; this pass has to divide by the series that retention
// produces, so both shaders genuinely need the uniform. `mergeParams` folds
// same-named specs into one GUI row and keeps the first, so the two
// declarations must not disagree — a differing range or default would be taken
// silently from whichever module loads first.
uniform float uDecay;      // @param 0.9 .. 1.0 = 0.95 "retention"

uniform float uGain;       // @param 0.5 .. 400.0 = 90.0 "density gain"
uniform float uGamma;      // @param 0.3 .. 2.0 = 0.72 "density curve"
uniform vec3  uPalA;       // @color = #14161f "background"
uniform vec3  uPalB;       // @color = #4a6fa8 "low density"
uniform vec3  uPalC;       // @color = #ffd9a0 "high density"
uniform float uSpeedTint;  // @param 0.0 .. 1.5 = 0.60 "speed tint"
uniform float uVignette;   // @param 0.0 .. 1.0 = 0.30 "vignette"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // The accumulation grid is absolutely sized, so this samples it bilinearly
    // rather than fetching texels: the whole strategy for printing a stateful
    // piece is that the simulation runs at a fixed sensible resolution and the
    // image pass recovers smoothness above it.
    vec2 uv = paUv(fragCoord);
    vec4 h = paBilinear(uHist, uv);

    // EFFECTIVE frames, not elapsed frames, and the difference is the whole
    // reason this piece can flow.
    //
    // The accumulator keeps `uDecay` of itself each step, so after N frames it
    // holds a geometric series: 1 + r + r^2 + ... + r^N. Dividing by N + 1 is
    // only right when r = 1. Below that the accumulator SATURATES at 1/(1-r)
    // while the divisor keeps growing, so the picture fades to black at a rate
    // nobody chose — measured, at r = 0.95, falling 64.5 -> 59.0 -> 48.3 across
    // frames 12, 40 and 120, and still falling. `uDecay` was therefore not a
    // retention knob at all; it was a slow fade-out, and the piece could only
    // ever be used at exactly 1.0.
    //
    // The closed form of that series is the correct divisor, and it degrades to
    // N + 1 as r -> 1, so one expression serves both regimes. The guard is
    // numerical rather than conceptual: (1 - r^N) / (1 - r) loses most of its
    // significant digits in float32 once r is within a thousandth of one, and
    // is a division by zero at exactly one.
    //
    // Fifth appearance of a normalisation that silently assumed a
    // configuration — 001, 008, 009, 005's depth floor, 006's bloom threshold.
    float frames = float(uFrame) + 1.0;
    float eff = uDecay > 0.999
        ? frames
        : (1.0 - pow(uDecay, frames)) / (1.0 - uDecay);
    float density = h.r / eff;
    // h.g carries weight * speed, so the ratio is the density-weighted mean
    // speed at this texel — an average over the orbits that landed here, which
    // is meaningful where a single orbit's speed would be noise.
    float speed = h.r > 1.0e-6 ? sat(h.g / h.r) : 0.0;

    float tone = safePow(log(1.0 + uGain * density) / log(1.0 + uGain), uGamma);

    vec3 col = colRamp3(tone, uPalA, uPalB, uPalC);
    col = mix(col, col * vec3(1.25, 0.92, 0.72), speed * uSpeedTint * tone);

    vec2 a = artCoord(fragCoord);
    col *= 1.0 - uVignette * sat(dot(a, a) * 1.6);

    fragColor = vec4(col, 1.0);
}
