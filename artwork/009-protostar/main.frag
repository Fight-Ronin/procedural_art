// 009 — Protostar
//
// A collapsing cloud with a hot core: emissive nebular filaments wound around
// a bright centre. Built in the idiom of the very short "hand-made universe"
// shaders — a marched volume, a wave-folded domain, an inverse-distance glow
// and a cosine palette — but built as this repo builds things, which changes
// two of those four in ways that matter more than they look.
//
// WHAT IS BORROWED IS THE IDIOM, NOT A PIECE. The genre's whole point is that
// the recipe is short enough to hold in your head; the interesting question for
// this repo was never "can it be copied" but "is the engine expressive enough
// to work in that register at all". It was, in four hours, once `noise/fold`
// existed — which is the answer that mattered.
//
// WHAT CHANGED, AND WHY.
//
// 1. THE GLOW IS AN INTEGRAL, NOT A SUM. The idiomatic line is `O += c / s`
//    where `s` is also the marching step, so halving the step count roughly
//    halves the brightness: the picture depends on the marcher's budget. That
//    is exactly the defect `test/volume.test.ts` exists to catch, and it is
//    fatal here rather than cosmetic, because this repo renders previews at one
//    step count and prints at another. Emission is integrated properly instead
//    — `L += Le * h` with `Le` the local glow density — so 48 steps and 160
//    steps agree, and the print is the preview at higher resolution rather than
//    a brighter picture.
//
// 2. THE BOUND COMES FROM THE WARP. `nzFoldBound` says how far the fold can
//    move a point, so the shell radius the density is measured against is
//    computed rather than guessed. Guessing it low clips the outer filaments
//    against the bounding sphere, which reads as a suspiciously circular edge
//    to the nebula and is very hard to attribute to its cause.
//
// The display transform is `tanh`, declared in meta.json: it has slope 1 at the
// origin and never clips, so the void stays black while the core saturates to
// white. ACES lifts blacks by design, which is right for a lit scene and wrong
// for a bright object on true black.
//
// mainImage returns LINEAR RADIANCE and runs far past 1 in the core, which is
// what the float accumulator and the bloom pass are for.

#include "core/math.glsl"
#include "core/const.glsl"
#include "color/palette.glsl"
#include "noise/fold.glsl"
#include "raymarch/camera.glsl"
#include "volume/emission.glsl"

uniform float uFold;     // @param 0.0 .. 3.0 = 0.95 "fold amount"
uniform int   uOct;      // @param 1 .. 10 = 8 step 1 "fold octaves"
uniform float uLac;      // @param 1.1 .. 2.2 = 1.43 "fold lacunarity"
uniform float uGain;     // @param 0.3 .. 0.95 = 0.78 "fold gain"

uniform float uScale;    // @param 0.2 .. 3.0 = 1.15 "domain scale"
uniform float uRing;     // @param 0.0 .. 2.0 = 0.55 "shell radius"
uniform float uThin;     // @param 0.02 .. 1.0 = 0.22 "shell thickness"
uniform float uCore;     // @param 0.0 .. 1.5 = 0.15 "core radius"

uniform float uGlow;     // @param 0.05 .. 4.0 = 0.65 "glow"
uniform float uFloor;    // @param 0.005 .. 0.3 = 0.035 "glow softness"
uniform float uReach;    // @param 0.2 .. 4.0 = 1.30 "glow reach"
uniform float uCoreGain; // @param 0.0 .. 40.0 = 6.0 "core brightness"
uniform float uAbsorb;   // @param 0.0 .. 2.0 = 0.35 "absorption"

uniform vec3  uPalA;     // @color = #3a3352 "palette bias"
uniform vec3  uPalB;     // @color = #9c5f33 "palette swing"
uniform float uPalFreq;  // @param 0.1 .. 3.0 = 1.35 "palette frequency"
uniform float uPalPhase; // @param 0.0 .. 1.0 = 0.62 "palette phase"

uniform float uDrift;    // @param 0.0 .. 0.4 = 0.055 "drift"
uniform float uOrbit;    // @param 0.0 .. 0.4 = 0.045 "orbit"
uniform float uFov;      // @param 0.4 .. 1.6 = 1.0 "field of view"
uniform float uDist;     // @param 2.0 .. 8.0 = 4.2 "camera distance"
uniform float uHigh;     // @param -2.0 .. 3.0 = 0.55 "camera height"

/**
 * How much light the medium makes at `p`, and how hot it is there.
 *
 * The shape is a SHELL rather than a ball: `abs(length - r)` puts the material
 * on a sphere of radius `uRing` and lets the fold tear that sphere into
 * strands. A solid ball folds into a solid ball — the fold needs a surface to
 * pull apart, which is the same lesson 008 learned about needing structure at a
 * scale above the filaments.
 *
 * `1 / (d + floor)` is the glow profile. It is not physical, and the reason to
 * keep it anyway is that it has a long tail: material a good distance from the
 * shell still contributes a little, which is what fills the space between
 * strands with haze instead of leaving them floating in black.
 */
float starGlow(vec3 p, float t, out float heat, out float tint) {
    vec3 q = nzFold3(p * uScale + vec3(0.0, 0.0, t), uOct, uLac, uGain, uFold);

    float shell = max(abs(length(q) - uRing) - uThin, 0.0);
    // COMPACTLY SUPPORTED, and that is not a detail. A bare 1/(d+floor) never
    // reaches zero, so every ray inside the bounding sphere picks up haze along
    // its whole length and the sphere itself becomes visible as a soft disc
    // behind the nebula — the piece stops having a background. Subtracting the
    // value at the cutoff drags the tail to exactly zero at `uReach` while
    // leaving the near profile almost untouched, so the haze between strands
    // survives and the disc does not.
    float glow = uGlow * max(1.0 / (shell + uFloor) - 1.0 / (uReach + uFloor), 0.0);

    float r = length(p);

    // The core is a separate, much brighter term rather than a tighter shell.
    // Folding a bright centre tears the centre up too, and a protostar whose
    // core is shredded reads as a nebula with no star in it.
    //
    // The profile is r^-2 with a softened centre rather than a Gaussian. A
    // Gaussian has no tail worth the name, so it renders as a disc with an
    // edge — a headlight — while an inverse square keeps feeding light into the
    // surrounding gas, which is what makes the core look like it is ILLUMINATING
    // the nebula rather than sitting in front of it.
    float core = uCoreGain * uCore * uCore / (r * r + uCore * uCore);
    core *= core;

    // TINT IS NOT HEAT. Colour has to be driven by something that varies ACROSS
    // the filaments, and `heat` does not: it is ~1 inside the core and ~0
    // everywhere else, so a ramp fed from it spends the whole picture at one
    // end and the piece comes out monochrome. That is the same mistake 001 made
    // with fbm height and 004 with its tone — a ramp can only work over the
    // range its driver actually traverses. The folded radius does traverse:
    // neighbouring strands sit at different depths in the warp.
    tint = sat(length(q) * 0.30 + r * 0.16);

    heat = sat(core / (core + glow + 1.0e-3));
    return glow + core;
}

/**
 * Cool gas, warm core. The cosine palette rides `tint`, and `heat` is added on
 * top as a separate whitening term rather than mixed into the ramp — a star's
 * core is not another hue further along the palette, it is the place the
 * palette stops mattering because everything saturates.
 */
vec3 starColor(float tint, float heat) {
    vec3 c = colCosPalette(tint * uPalFreq + uPalPhase,
        uPalA, uPalB, vec3(1.0, 0.92, 0.78), vec3(0.0, 0.16, 0.38));
    return c + vec3(1.0, 0.86, 0.62) * heat * heat * 2.2;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);
    float t = uTime * uDrift;

    float a = uTime * uOrbit;
    vec3 eye = vec3(sin(a), 0.0, cos(a)) * uDist + vec3(0.0, uHigh, 0.0);
    vec3 ro, rd;
    rmCamera(uv, eye, vec3(0.0), vec3(0.0, 1.0, 0.0), uFov, ro, rd);

    // The warp moves points by at most nzFoldBound per component, so the
    // material can reach that much further out than the shell radius. Sizing
    // the sphere from the number instead of by eye is the difference between a
    // nebula and a nebula with a circle cut out of it.
    float reach = (uRing + uThin + nzFoldBound(uOct, uGain, uFold)) / max(uScale, 1.0e-3);
    vec2 span = volSphereSpan(ro, rd, vec3(0.0), reach + 0.5);

    vec3 L = vec3(0.0);
    float T = 1.0;

    if (span.y > span.x) {
        float t0 = max(span.x, 0.0);
        float h = (span.y - t0) / float(uQuality > 0 ? 160 : 48);
        int steps = uQuality > 0 ? 160 : 48;

        // Jittered start. Marching from a fixed offset every ray writes the
        // step pattern into the picture as concentric shells; jittering turns
        // that into noise the sampling loop averages away.
        float s = t0 + h * paRand();

        for (int i = 0; i < 160; ++i) {
            if (i >= steps || T < 0.003) break;
            float heat, tint;
            float e = starGlow(ro + rd * s, t, heat, tint);
            // Emission integrated over the step, absorption proportional to it.
            // Absorption is what gives the near filaments an edge against the
            // ones behind them; with none of it the whole cloud is transparent
            // and reads flat however bright it gets.
            float sigma = uAbsorb * e * 0.05;
            volStep(L, T, starColor(tint, heat) * e, max(sigma, 1.0e-5), h);
            s += h;
        }
    }

    fragColor = vec4(L, 1.0);
}
