// 002 — Vitreous
//
// Two interlocked tori, twisted, smooth-unioned into a knot, rendered as solid
// glass: Fresnel reflection outside, refraction in, Beer-Lambert absorption
// through the interior, total internal reflection handled explicitly, and true
// dispersion.
//
// The dispersion is the reason this piece exists. Each sample picks ONE
// wavelength, refracts at that wavelength's index, and is weighted by that
// wavelength's colour response; viz's supersampling loop averages them. So the
// spectrum is integrated by the same machinery that does antialiasing, and
// raising spp buys smoother edges and finer rainbows at once. Three fixed RGB
// taps — the usual shortcut — cannot produce a continuous fringe.

// The display transform — exposure, tonemap, sRGB encode, dither — belongs to
// viz's resolve pass and is declared in meta.json. mainImage returns LINEAR
// RADIANCE and nothing else; values above 1 are meant to survive to be rolled
// off after the samples are averaged, not clamped inside each one.

#include "core/math.glsl"
#include "sdf/prim3d.glsl"
#include "sdf/ops.glsl"
#include "sdf/transform.glsl"
#include "raymarch/march.glsl"
#include "env/sky.glsl"
#include "optics/glass.glsl"

// ---- shape ----
uniform float uMajor;    // @param 0.4 .. 1.6 = 0.95 "ring radius"
uniform float uMinor;    // @param 0.05 .. 0.5 = 0.26 "tube radius"
uniform float uSpread;   // @param 0.0 .. 1.2 = 0.42 "ring separation"
uniform float uTwist;    // @param -2.0 .. 2.0 = 0.6 "twist"
uniform float uWeld;     // @param 0.01 .. 0.6 = 0.22 "weld"

// ---- glass ----
uniform float uIor;      // @param 1.0 .. 2.4 = 1.52 "index of refraction"
uniform float uDisperse; // @param 0.0 .. 0.08 = 0.032 "dispersion"
uniform vec3  uTint;     // @color = #6fc7cf "glass tint"
uniform float uDensity;  // @param 0.0 .. 8.0 = 0.85 "tint strength"
uniform int   uBounces;  // @param 1 .. 5 = 3 step 1 "internal bounces"

// ---- environment ----
uniform int   uEnvMode;  // @enum 0:studio 1:gradient 2:bands "environment"
uniform vec3  uSkyUp;    // @color = #cfd9e8 "sky up"
uniform vec3  uSkyDown;  // @color = #0b0c12 "sky down"
uniform float uSunYaw;   // @param -3.15 .. 3.15 = 0.9 "light yaw"
uniform float uSunPitch; // @param -1.5 .. 1.5 = 0.65 "light pitch"
uniform float uSunPower; // @param 0.0 .. 40.0 = 14.0 "light power"

// ---- camera / grade ----
uniform float uFov;      // @param 0.3 .. 1.6 = 0.72 "field of view"
uniform float uDist;     // @param 2.0 .. 8.0 = 4.1 "camera distance"
uniform float uSpin;     // @param 0.0 .. 0.3 = 0.05 "spin speed"
uniform float uPitch;    // @param -1.2 .. 1.2 = 0.32 "camera pitch"

// The scene. march.glsl declares this as a prototype and calls it.
float sceneSdf(vec3 p) {
    // opTwist is NOT distance-preserving, so the marcher below runs with a
    // reduced step scale. Skipping that shows up as thin holes in the tube.
    p = opTwist(p, uTwist);

    float a = sdTorus(p - vec3(0.0, uSpread * 0.5, 0.0), uMajor, uMinor);

    vec3 q = p + vec3(0.0, uSpread * 0.5, 0.0);
    q = vec3(q.x, q.z, q.y);            // rotate the second ring 90 degrees
    float b = sdTorus(q, uMajor, uMinor);

    return opSmoothUnion(a, b, uWeld);
}

vec3 envLookup(vec3 rd) {
    vec3 sun = vec3(cos(uSunPitch) * cos(uSunYaw), sin(uSunPitch), cos(uSunPitch) * sin(uSunYaw));
    if (uEnvMode == 1) {
        return envGradient(rd, uSkyDown, uSkyUp, sun, vec3(uSunPower), 0.06);
    }
    if (uEnvMode == 2) {
        return envBands(rd, 9.0, uSkyDown, uSkyUp) + vec3(uSunPower * 0.02);
    }
    vec3 fill = normalize(vec3(-sun.x, 0.35, -sun.z));
    vec3 rim = normalize(vec3(-sun.x, -0.2, sun.z));
    return envStudio(rd, sun, fill, rim, uSunPower, uSunPower * 0.25, uSunPower * 0.6, uSkyDown)
         + uSkyUp * 0.25;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);

    float ang = uTime * uSpin * TAU;
    vec3 eye = vec3(sin(ang), sin(uPitch), cos(ang)) * uDist;
    eye.y = sin(uPitch) * uDist;
    vec3 ro, rd;
    rmCamera(uv, eye, vec3(0.0), vec3(0.0, 1.0, 0.0), uFov, ro, rd);

    // Tolerance is the world footprint of one pixel, so the surface resolves to
    // exactly the precision the output can show — at 512px and at 8000px alike.
    float foot = rmFootprint(pxSize(), uFov);
    int steps = uQuality > 0 ? 160 : 96;
    const float STEP = 0.7;   // opTwist over-estimates; do not raise this

    vec3 col;
    RmHit h = rmMarch(ro, rd, 0.0, uDist * 3.0, steps, foot, STEP);

    if (!h.hit) {
        col = envLookup(rd);
    } else {
        // One wavelength per sample, drawn from a STRATIFIED sequence rather
        // than white noise: each pixel walks the spectrum evenly while its
        // neighbours use different points, so the residual is fine texture
        // instead of colour speckle. Base 5 because 2 and 3 are the pixel jitter.
        float nm = optSampleWavelength(paStrat(5));
        float ior = uIor + uDisperse * (1.0 / pow(nm * 1e-3, 2.0) - 1.0 / pow(0.55, 2.0));
        vec3 response = optWavelengthToLinearSrgb(nm);

        vec3 p = ro + rd * h.t;
        vec3 n = rmNormal(p, max(foot * h.t, 1e-4));

        float cosI = sat(dot(-rd, n));
        float F = optFresnelDielectric(cosI, 1.0 / ior);
        vec3 reflected = envLookup(reflect(rd, n));

        // Enter the glass.
        vec3 dir;
        optRefract(rd, n, 1.0 / ior, dir);
        vec3 pos = p - n * max(foot * h.t, 1e-4) * 4.0;

        vec3 throughput = vec3(1.0);
        vec3 transmitted = vec3(0.0);
        bool escaped = false;

        for (int i = 0; i < uBounces; ++i) {
            RmHit inside = rmMarchInside(pos, dir, uDist * 3.0, steps, foot, STEP);
            if (!inside.hit) break;

            // Beer-Lambert over the chord just travelled: thick parts of the
            // object go dark and saturated, thin parts stay clear. This is what
            // reads as volume rather than as a coloured surface.
            // uTint is the colour a unit of glass TRANSMITS, which is how a
            // person picks it; absorption is its negative log. Exposing the
            // absorption coefficient directly gives a control where every
            // useful value sits in the bottom few percent of the slider.
            vec3 sigma = -log(max(uTint, vec3(1e-3))) * uDensity;
            throughput *= optBeer(sigma, inside.t);

            vec3 exitP = pos + dir * inside.t;
            vec3 exitN = -rmNormal(exitP, max(foot * inside.t, 1e-4));

            vec3 outDir;
            if (optRefract(dir, exitN, ior, outDir)) {
                transmitted = envLookup(outDir) * throughput;
                escaped = true;
                break;
            }
            // Total internal reflection: stay inside and go around again.
            dir = outDir;
            pos = exitP + dir * max(foot * inside.t, 1e-4) * 4.0;
        }
        if (!escaped) transmitted = envLookup(dir) * throughput * 0.6;

        col = mix(transmitted * response, reflected, F);
    }

    fragColor = vec4(col, 1.0);
}
