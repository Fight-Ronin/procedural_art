// 005 — Scarp
//
// An eroded form, lit. The first opaque object in the repo.
//
// 002 raymarched glass and got away with having no shading model, because glass
// is nearly all transmission — what you see through it is the picture. An
// opaque surface has nowhere to hide: it is entirely a question of how it turns
// light around, and that is what `basics/shade/brdf.glsl` had to exist for.
// This piece is what forced it, along with `noise/noise3.glsl` — a marched
// surface has to be textured and displaced in three dimensions, and every noise
// in the repo before this was two-dimensional.
//
// The displacement is ridged rather than plain fbm because erosion CUTS. Plain
// fbm gives a lumpy potato; folding it at zero gives channels and ridges, which
// is what water leaves behind.

#include "core/math.glsl"
#include "sdf/prim3d.glsl"
#include "sdf/ops.glsl"
#include "sdf/transform.glsl"
#include "raymarch/march.glsl"
#include "raymarch/shade.glsl"
#include "noise/noise3.glsl"
#include "shade/brdf.glsl"
#include "env/sky.glsl"
#include "color/spaces.glsl"
#include "color/tonemap.glsl"

uniform float uErode;     // @param 0.0 .. 0.5 = 0.22 "erosion depth"
uniform float uErodeFreq; // @param 0.3 .. 4.0 = 1.35 "erosion scale"
uniform int   uErodeOct;  // @param 1 .. 6 = 4 step 1 "erosion detail"
uniform float uTwist;     // @param -1.5 .. 1.5 = 0.42 "twist"
uniform float uSpin;      // @param 0.0 .. 0.4 = 0.06 "turn speed"

uniform vec3  uRock;      // @color = #8a7c6b "rock"
uniform vec3  uSeam;      // @color = #3c4a52 "seam"
uniform float uRough;     // @param 0.05 .. 1.0 = 0.55 "roughness"
uniform float uMetal;     // @param 0.0 .. 1.0 = 0.0 "metallic"

uniform float uSunYaw;    // @param -3.15 .. 3.15 = -0.85 "sun yaw"
uniform float uSunPitch;  // @param 0.05 .. 1.5 = 0.62 "sun pitch"
uniform float uSunPower;  // @param 0.0 .. 20.0 = 9.5 "sun power"
uniform vec3  uSunColor;  // @color = #ffe6c4 "sun"
uniform vec3  uSkyUp;     // @color = #6f8ba8 "sky"
uniform vec3  uSkyDown;   // @color = #4a3a2c "ground bounce"

uniform float uAmbient;   // @param 0.0 .. 3.0 = 0.80 "sky fill"
uniform float uDist;      // @param 2.0 .. 7.0 = 4.30 "camera distance"
uniform float uHeight;    // @param -0.5 .. 2.5 = 1.15 "camera height"
uniform float uAo;        // @param 0.0 .. 1.0 = 0.75 "ambient occlusion"
uniform float uExposure;  // @param -2.0 .. 2.0 = -0.10 "exposure"
uniform float uVignette;  // @param 0.0 .. 1.0 = 0.35 "vignette"

/**
 * How deep the erosion cuts at a point. Kept in one place because `sceneSdf`
 * and the shading both want it: the displacement is also what decides where
 * the rock is fresh and where it is worn, so it drives the material too.
 */
float scarpErosion(vec3 p) {
    // uQuality gates octaves, not resolution. It is constant across an
    // accumulation run, so every sample being averaged sees the same field.
    int oct = uQuality > 0 ? uErodeOct + 1 : uErodeOct;
    return nzRidged31(p * uErodeFreq, oct, 2.03, 0.5);
}

/**
 * The one sanctioned break in the purity rule: basics/ declares this prototype
 * and the artwork defines it, because GLSL has no function pointers.
 *
 * Displacing a distance field DESTROYS the Lipschitz bound the marcher relies
 * on — the field now over-estimates by up to the displacement amplitude, so a
 * full step tunnels straight through a ridge. That is what rmMarch's stepScale
 * is for, and why this piece marches at well under 1.
 */
float sceneSdf(vec3 p) {
    vec3 q = opTwist(p, uTwist);

    // A blunt mass rather than a sphere: the erosion reads as erosion only if
    // there are edges for it to round off.
    float body = opSmoothUnion(
        sdRoundBox(q - vec3(0.0, 0.15, 0.0), vec3(0.62, 0.44, 0.52), 0.18),
        sdSphere(q - vec3(0.28, -0.30, 0.12), 0.55),
        0.30);

    body -= uErode * scarpErosion(p);

    float ground = sdPlane(p - vec3(0.0, -0.92, 0.0), vec3(0.0, 1.0, 0.0), 0.0);
    // Ground erodes too, at a tenth the depth — a perfectly flat plane under an
    // eroded object reads as a studio backdrop, not as ground.
    ground -= uErode * 0.1 * scarpErosion(p * 0.7);

    return opSmoothUnion(body, ground, 0.12);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);

    float t = uTime * uSpin;
    vec3 eye = vec3(sin(t) * uDist, uHeight, cos(t) * uDist);
    vec3 ro, rd;
    float fov = 0.62;
    rmCamera(uv, eye, vec3(0.0, -0.05, 0.0), vec3(0.0, 1.0, 0.0), fov, ro, rd);

    vec3 sun = normalize(vec3(
        cos(uSunPitch) * cos(uSunYaw), sin(uSunPitch), cos(uSunPitch) * sin(uSunYaw)));

    // Cone-traced tolerance: the surface is resolved to exactly the precision
    // the output can show, at 400px and at 8000px alike.
    float foot = rmFootprint(pxSize(), fov);
    int steps = uQuality > 0 ? 150 : 90;
    RmHit h = rmMarch(ro, rd, 0.02, 12.0, steps, foot, 0.5);

    vec3 col;
    if (!h.hit) {
        col = envGradient(rd, uSkyDown, uSkyUp, sun, uSunColor * uSunPower * 0.06, 0.02);
    } else {
        vec3 p = ro + rd * h.t;
        vec3 n = rmNormal(p, max(foot * h.t, 1e-4));
        vec3 v = -rd;

        // The erosion drives the material, not just the shape. Worn rock is
        // smoother and greyer than the fresh faces the channels expose, which
        // is the whole reason to keep the field rather than only its effect.
        float wear = sat(scarpErosion(p) * 1.35);
        vec3 albedo = colMixOklab(uSeam, uRock, wear);
        ShMaterial mat = shMaterial(albedo, clamp(uRough * (1.25 - wear * 0.5), 0.05, 1.0), uMetal);

        float ao = mix(1.0, rmAo(p, n, 0.35), uAo);
        float sh = rmSoftShadow(p + n * foot * h.t * 2.0, sun, 0.02, 6.0, 12.0, 48);

        vec3 lit = shDirect(mat, n, v, sun, uSunColor * uSunPower * sh);

        // A cheap stand-in for image-based lighting: what the sky delivers to a
        // surface facing n, and what it delivers along the mirror direction.
        // Both come from the same environment the miss path shows, so the
        // object sits in the scene rather than on top of it.
        vec3 irr = envGradient(n, uSkyDown, uSkyUp, sun, vec3(0.0), 0.0) * ao * uAmbient;
        vec3 refl = envGradient(reflect(-v, n), uSkyDown, uSkyUp, sun,
                                uSunColor * uSunPower * 0.05, 0.05) * ao * uAmbient;
        col = lit + shAmbient(mat, n, v, irr, refl);

        // Distance haze, tinted by the sky. Without it the far ground meets the
        // horizon at full contrast and the frame reads as flat.
        float haze = 1.0 - exp(-h.t * 0.10);
        col = mix(col, envGradient(rd, uSkyDown, uSkyUp, sun, vec3(0.0), 0.0), haze * 0.55);
    }

    col = colExposure(col, uExposure);
    col *= mix(1.0, smoothstep(1.25, 0.25, length(uv)), uVignette);
    fragColor = vec4(colTonemapAces(col), 1.0);
}
