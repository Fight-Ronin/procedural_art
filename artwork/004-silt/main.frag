// 004 — Silt
//
// A cellular field dragged along the streamlines of a divergence-free flow.
//
// The idea is line integral convolution: for each pixel, walk BACKWARD through
// the velocity field and average what you find along the way. Averaging along a
// streamline blurs hard across the flow and not at all along it, so an
// isotropic field of cells comes out as filaments — sediment in a current. The
// cells give it something to be made of; the flow gives it direction. Either
// alone is noise.
//
// This is what forced basics/noise/deriv, noise/curl, noise/worley and
// field/flow into existence.
//
// Stateless on purpose. A dye field advected in a buffer would be the obvious
// way to get this look, and its detail would be capped forever by the
// simulation grid — 003's whole print problem. Integrating the streamline
// per-pixel instead means the filaments are as fine as the output is, at 400px
// and at 8000px, and the piece tiles bit-identically because it is still a pure
// function of (position, frame, seed).

// The display transform — exposure, tonemap, sRGB encode, dither — belongs to
// viz's resolve pass and is declared in meta.json. mainImage returns LINEAR
// RADIANCE and nothing else; values above 1 are meant to survive to be rolled
// off after the samples are averaged, not clamped inside each one.

#include "core/math.glsl"
#include "field/flow.glsl"
#include "noise/worley.glsl"
#include "noise/fbm.glsl"
#include "color/palette.glsl"
#include "color/spaces.glsl"

uniform float uFlowScale;  // @param 0.2 .. 4.0 = 1.15 "eddy size"
uniform float uFlowAmp;    // @param 0.0 .. 2.0 = 0.85 "flow strength"
uniform int   uFlowOct;    // @param 1 .. 5 = 3 step 1 "flow detail"
uniform float uDrift;      // @param 0.0 .. 0.3 = 0.035 "drift speed"

uniform float uCellScale;  // @param 1.0 .. 120.0 = 62.0 "cell density"
uniform float uJitter;     // @param 0.0 .. 1.0 = 0.62 "cell irregularity"
uniform float uWall;       // @param 0.0 .. 1.0 = 0.85 "walls vs centres"

uniform int   uSteps;      // @param 4 .. 48 = 28 step 1 "smear length"
uniform float uStride;     // @param 0.002 .. 0.06 = 0.026 "step size"
uniform float uTaper;      // @param 0.0 .. 1.0 = 0.55 "taper along the smear"
uniform float uGrain;      // @param 0.0 .. 6.0 = 1.7 "filament contrast"
uniform float uBand;       // @param 0.05 .. 1.0 = 0.55 "filament fineness"
uniform float uLoad;       // @param 0.0 .. 1.0 = 0.72 "how much water carries silt"

uniform vec3  uDeep;       // @color = #10131c "deep"
uniform vec3  uSilt;       // @color = #7d6a52 "silt"
uniform vec3  uPale;       // @color = #e8dcc4 "pale"
uniform float uSpread;     // @param 0.2 .. 3.0 = 1.35 "tonal spread"
uniform float uVignette;   // @param 0.0 .. 1.0 = 0.42 "vignette"

/**
 * What gets smeared. F2 - F1 is zero on the wall between two cells and rises
 * into their interiors, so `uWall` crossfades between drawing the walls and
 * drawing the bodies. The jitter default sits just under the bound at which a
 * 3x3 search stops being provably sufficient (see noise/worley.glsl) — this is
 * evaluated once per integration step, so the narrower ring is worth staying
 * inside, and it still looks properly irregular.
 */
float siltField(vec2 p, int seed) {
    NzWorleyF w = nzWorley21f(p * uCellScale, uJitter, seed);
    float walls = 1.0 - sat((w.f2 - w.f1) * 1.6);
    float bodies = sat(1.0 - w.f1 * 1.35);
    return mix(bodies, walls, uWall);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = artCoord(fragCoord);

    // Frame-driven, so every frame is reproducible from (seed, frame) alone.
    vec2 offset = vec2(uTime * uDrift, uTime * uDrift * -0.7);

    // The streamfunction at this point. Streamlines ARE its level sets, so a
    // value derived from it is constant along the flow — which is the right
    // shape for "how much material this water is carrying", since material is
    // carried along streamlines and not across them. Spreading the filaments
    // evenly over the frame was what made the earlier versions read as engraved
    // metal: silt needs clear water somewhere to be silt rather than pattern.
    //
    // One extra fbm evaluation against roughly ninety inside the loop.
    float psi = nzFbm21d(p * uFlowScale + offset, uFlowOct, 2.0, 0.5).x;
    float load = mix(1.0, sat(0.5 + psi * 1.9), uLoad);

    // Quality buys smear length, not resolution: uQuality is constant across an
    // accumulation run, so this cannot differ between the samples being averaged.
    int steps = uQuality > 0 ? uSteps + uSteps / 2 : uSteps;

    // Backward: negative stride asks where the material here came from.
    float dt = -uStride;

    // TWO weightings accumulated in ONE loop, from the SAME field samples: a
    // long smear over the whole path and a short one over its first fraction.
    //
    // Their difference is a band-pass along the streamline, and it is the thing
    // that makes this piece work. Averaging a cellular field over several cells
    // is a low-pass, and the first version of this shader did exactly that and
    // produced smooth marbling with no cells left in it — the smear had eaten
    // the very structure it was supposed to be smearing. What survives such an
    // average is not the cells but the correlated fluctuation ALONG the
    // streamline, which is small (it falls off as sqrt(cell size / smear
    // length)) and completely swamped unless it is isolated and amplified.
    //
    // The second accumulator costs nothing: no extra field evaluations, no
    // extra flow steps, just a second running sum over samples already taken.
    float sumLong = 0.0;
    float normLong = 0.0;
    float sumShort = 0.0;
    float normShort = 0.0;
    vec2 q = p;
    vec2 start = p;

    for (int i = 0; i < steps; ++i) {
        // Euler rather than RK2, and the reason is in field/flow.glsl: for
        // smearing, the same budget spent on more steps buys more places to
        // sample the field, and that helps the picture more than a more
        // accurate path does.
        q = flowStepEuler(q, dt, uFlowScale, uFlowAmp, offset, uFlowOct);

        // Taper the tail so the smear fades out instead of ending. A hard cut
        // leaves every filament the same length, which reads as a texture with
        // a grain size rather than as movement.
        float t = float(i) / float(max(steps - 1, 1));
        float w = mix(1.0, 1.0 - t, uTaper);
        float f = siltField(q, uSeed);
        sumLong += w * f;
        normLong += w;

        // Smoothly windowed rather than a hard cut at uBand: a hard window
        // makes the band-pass ring, which shows up as a ghost filament trailing
        // every real one.
        float ws = w * (1.0 - smoothstep(0.0, 1.0, t / max(uBand, EPS)));
        sumShort += ws * f;
        normShort += ws;
    }
    float smearLong = sumLong / max(normLong, EPS);
    float smearShort = sumShort / max(normShort, EPS);
    float smear = smearLong;

    // The filaments. Centred on zero by construction, because it is a
    // difference of two averages of the same field.
    float grain = (smearShort - smearLong) * uGrain * load;

    // How far the material travelled. This is the large-scale composition — the
    // same lesson 001 taught: colouring by the smeared field alone gives even
    // mush, because the smear is a local average and local averages are flat.
    // Displacement varies on the scale of the eddies, which is the scale the
    // eye reads as structure.
    float travel = length(q - start) / max(float(steps) * uStride, EPS);

    // Composition from the flow, substance from the filaments. The weighting
    // is deliberate and was arrived at by looking: leaning on `travel` gives a
    // handsome marble with nothing in it, leaning on `grain` gives busy noise
    // with no shape.
    float base = pow(sat(smear), uSpread);
    // The weights are set so `tone` actually SPANS [0,1] rather than hovering
    // near its middle. The first version summed to about 0.55 everywhere, and a
    // three-stop ramp evaluated only around its midpoint is a one-colour ramp:
    // the frame came out uniformly the mid tone with the deep and pale stops
    // never reached at all. A palette can only do work over the range the tone
    // actually visits.
    float tone = sat(0.05 + base * 0.42 * load + travel * 0.55 + grain);

    vec3 col = colMixOklab(uDeep, uSilt, sat(tone * 1.35));
    col = colMixOklab(col, uPale, sat((tone - 0.62) * 2.6));

    // A faint directional sheen: material moving across the frame catches a
    // little more light than material moving along it. Cheap, and it is what
    // stops the filaments reading as flat paint.
    vec2 dir = safeNorm(q - start);
    col *= 1.0 + 0.10 * dir.y * smear;

    // Filaments carry a touch more of the pale end than the tone ramp alone
    // gives them, which is what reads as suspended material catching light
    // rather than as a lighter patch of the same paint.
    col = colMixOklab(col, uPale, sat(grain * 0.9));

    float r = length(p * vec2(1.0, 1.0));
    col *= mix(1.0, smoothstep(1.15, 0.15, r), uVignette);

    fragColor = vec4(col, 1.0);
}
