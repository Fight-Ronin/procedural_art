// 008 — Ember
//
// The first piece here that makes its own light. Seven pieces in, everything
// this repo could render was a surface with light arriving from somewhere else:
// a field, glass, a simulation, a flow, terrain, a vault lit by a lamp, a
// drawing. That mattered more than it sounds, because it meant the float
// accumulator and the bloom pass — both built, both tested — had almost nothing
// to do. Radiance above 1 is what they are for, and only a source in frame
// produces any. 002 and 005 were both tried with bloom and measured flat.
//
// So this is emission-absorption: no lights, no BRDF, no surface. The ray picks
// up whatever the medium emits and loses whatever it absorbs, which is
// `basics/volume/emission.glsl` — the module this piece forced.
//
// THE LOOP IS HERE AND THE MATHEMATICS IS THERE, deliberately. A whole
// integrator in basics/ would need this file's density and emission functions,
// and GLSL has no function pointers, so it would need a second undefined
// prototype beside `sceneSdf` — and `test/layers.test.ts` exists to stop the
// one sanctioned exception becoming two. `field/flow.glsl` refused the same
// temptation for the same reason.
//
// Structure comes from a scale ABOVE the filaments: a twisted torus sets where
// the ember is, ridged noise sets what it looks like up close. 001 and 004 both
// had to learn that the hard way — colour driven by a local average is uniform
// mush, because a local average is flat by construction.
//
// The display transform belongs to viz's resolve pass and is declared in
// meta.json. mainImage returns LINEAR RADIANCE, and here it genuinely runs past
// 1 in the hot cores, which is the point.

#include "core/math.glsl"
#include "hash/hash.glsl"
#include "noise/noise3.glsl"
#include "color/palette.glsl"
#include "raymarch/camera.glsl"
#include "sdf/prim3d.glsl"
#include "sdf/transform.glsl"
#include "volume/emission.glsl"

uniform float uBound;    // @param 1.2 .. 4.0 = 2.2 "bounding radius"
uniform float uMajor;    // @param 0.2 .. 1.6 = 1.15 "core radius"
uniform float uMinor;    // @param 0.05 .. 0.8 = 0.30 "core thickness"
uniform float uTwist;    // @param 0.0 .. 4.0 = 1.35 "twist"

uniform float uReach;    // @param 0.05 .. 1.2 = 0.20 "glow reach"
uniform float uFreq;     // @param 0.3 .. 4.0 = 2.4 "filament scale"
uniform int   uOct;      // @param 1 .. 6 = 4 step 1 "filament octaves"
uniform float uFloor;    // @param 0.0 .. 0.9 = 0.62 "filament floor"
uniform float uSharp;    // @param 1.0 .. 8.0 = 2.2 "filament sharpness"

uniform float uDensity;  // @param 0.5 .. 20.0 = 6.0 "density"
uniform float uEmit;     // @param 0.2 .. 8.0 = 1.8 "emission"
uniform float uHeat;     // @param 0.5 .. 4.0 = 1.9 "heat contrast"

uniform float uDrift;    // @param 0.0 .. 0.5 = 0.09 "drift speed"
uniform float uOrbit;    // @param 0.0 .. 0.5 = 0.06 "orbit speed"
uniform float uFov;      // @param 0.4 .. 1.6 = 0.95 "field of view"
uniform float uDist;     // @param 2.0 .. 6.0 = 3.2 "camera distance"
uniform float uHigh;     // @param -1.0 .. 3.5 = 2.4 "camera height"

uniform vec3  uCoal;     // @color = #4b0d06 "coal"
uniform vec3  uFlame;    // @color = #ff5a1e "flame"
uniform vec3  uCore;     // @color = #ffe6b0 "core"
uniform vec3  uNight;    // @color = #05060b "background"

/**
 * How much medium is at `p`, and how hot it is.
 *
 * `shell` is an exponential falloff from the core surface, so the ember has a
 * definite body with a soft edge rather than a hard boundary — a hard one reads
 * as a cut-out no matter how good the noise is. `fil` is ridged noise raised to
 * a power, which is what turns a cloud into filaments: the power pushes the
 * mid-tones down and leaves the ridges standing.
 *
 * Heat rides on the PRODUCT rather than on density alone, so the hottest places
 * are where a thick filament sits near the core, not merely wherever the noise
 * happens to peak. Without that the ember has bright specks in its own outer
 * haze, which reads as noise rather than as fire.
 */
float emberMedium(vec3 p, float t, int oct, out float heat) {
    vec3 q = opTwist(p, uTwist);
    float core = sdTorus(q, uMajor, uMinor);

    float shell = exp(-max(core, 0.0) / uReach);
    float fil = nzRidged31(p * uFreq + vec3(0.0, -t, t * 0.35), oct, 2.03, 0.5);
    // CONTRAST-EXPAND BEFORE THE POWER. nzRidged31 is a fold — a mean of
    // (1 - |n|) — so it has a floor and sits around 0.7 nearly everywhere. A
    // power alone therefore darkens the whole volume uniformly instead of
    // sparsifying it, and the ember comes out a solid glowing lump with no
    // filaments in it at all. Measured by rendering the field directly: shell,
    // ridge and heat were all saturated across the entire body. Subtracting the
    // floor first is what puts the bulk near zero and leaves the ridges
    // standing — the same contrast expansion 004 needed, for the same reason.
    fil = sat((fil - uFloor) / max(1.0 - uFloor, 1.0e-3));
    fil = safePow(fil, uSharp);

    heat = sat(shell * fil * uHeat);
    return uDensity * shell * fil;
}

/** Coal to flame to core: a temperature ramp, superlinear at the top. */
vec3 emberEmission(float heat) {
    vec3 c = colRamp3(heat, uCoal, uFlame, uCore);
    // The square is what puts the hot cores above 1 while leaving the haze
    // below it. A linear ramp keeps everything inside the display range, the
    // tonemap has nothing to roll off, and the bloom pass has nothing to find.
    return c * uEmit * (0.15 + heat * heat * 2.2);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);
    float t = uTime * uDrift;

    float a = uTime * uOrbit;
    vec3 eye = vec3(sin(a), 0.0, cos(a)) * uDist + vec3(0.0, uHigh, 0.0);
    vec3 ro, rd;
    rmCamera(uv, eye, vec3(0.0), vec3(0.0, 1.0, 0.0), uFov, ro, rd);

    vec3 L = vec3(0.0);
    float T = 1.0;

    vec2 span = volSphereSpan(ro, rd, vec3(0.0), uBound);
    if (span.y > span.x) {
        float t0 = max(span.x, 0.0);
        float t1 = span.y;
        // Steps are gated on quality, and that is safe HERE in a way it is not
        // everywhere: volStep is exact for a constant segment at any step size,
        // so raising the count refines how well the steps resolve the density
        // field and does not also change the brightness. With the first-order
        // integrator the two are tangled and "more steps" quietly means
        // "darker", which is the whole reason test/volume.test.ts exists.
        int steps = uQuality > 0 ? 128 : 56;
        int oct = uQuality > 0 ? uOct + 1 : uOct;
        float h = (t1 - t0) / float(steps);

        // A jittered start, not a fixed one. Marching from the same offset
        // every ray puts the step pattern in the picture as concentric shells;
        // jittering turns that into noise the sampling loop then averages away.
        float s = t0 + h * paRand();

        for (int i = 0; i < 128; ++i) {
            if (i >= steps || T < 0.004) break;
            float heat;
            float sigma = emberMedium(ro + rd * s, t, oct, heat);
            if (sigma > 1.0e-4) volStep(L, T, emberEmission(heat), sigma, h);
            s += h;
        }
    }

    // Whatever light was not blocked shows the night behind it. A flat black
    // would be honest too, but the faint vertical lift gives the ember
    // somewhere to sit.
    vec3 sky = uNight * (0.6 + 0.9 * sat(uv.y + 0.55));
    L += T * sky;

    fragColor = vec4(L, 1.0);
}
