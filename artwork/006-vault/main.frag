// 006 — Vault
//
// A rotunda of repeated columns, lit through an aperture overhead.
//
// Deliberately built from the parts of basics/ that no piece had touched:
// opPolarRepeat, opRepeatLimited, opSubtract, opSmoothUnionM, sdCylinder,
// sdHexPrism, colCosPalette. Five pieces in, most of the SDF library had never
// been called by anything, which is a decent sign that the next artwork should
// come from the library rather than from a list of things to add to it.
//
// The new capability is SINGLE-SCATTERING along the view ray — the light shafts.
// That is the "finish" a marched scene usually lacks, and it is worth having in
// this form specifically: it is a per-pixel integral along one ray, so it stays
// a pure function of (position, frame, seed) and tiled export is still
// byte-identical. A post-process bloom would read neighbouring pixels and break
// that outright.
//
// The scene SDF is kept CHEAP on purpose — pure primitives, no noise. 005 spends
// its budget on a displaced field and can afford no volumetrics; this one spends
// it the other way round. Both march; they are not the same kind of expensive.

// The display transform — exposure, tonemap, sRGB encode, dither — belongs to
// viz's resolve pass and is declared in meta.json. mainImage returns LINEAR
// RADIANCE and nothing else; values above 1 are meant to survive to be rolled
// off after the samples are averaged, not clamped inside each one.

#include "core/math.glsl"
#include "sdf/prim3d.glsl"
#include "sdf/ops.glsl"
#include "sdf/transform.glsl"
#include "raymarch/march.glsl"
#include "raymarch/shade.glsl"
#include "shade/brdf.glsl"
#include "color/palette.glsl"
#include "color/spaces.glsl"

uniform float uColumns;   // @param 5.0 .. 24.0 = 11.0 "columns"
uniform float uRadius;    // @param 1.2 .. 3.5 = 2.05 "ring radius"
uniform float uThick;     // @param 0.06 .. 0.5 = 0.20 "column thickness"
uniform float uAperture;  // @param 0.15 .. 1.6 = 1.00 "aperture"
uniform float uSpin;      // @param 0.0 .. 0.3 = 0.045 "turn speed"
// The camera lives INSIDE the dome. The dome is a sphere of radius 3.5 centred
// at y = -1.3, and everything outside it is solid, so an eye placed beyond that
// is embedded in the ceiling and sees the inside of the stone. Ask for less
// than about 3.2 here.
uniform float uDist;      // @param 0.4 .. 3.2 = 1.35 "camera distance"
uniform float uEyeY;      // @param -1.2 .. 1.2 = -0.60 "camera height"
uniform float uLookY;     // @param -1.0 .. 2.5 = 1.00 "look height"
uniform float uFov;       // @param 0.5 .. 1.6 = 1.15 "field of view"

uniform float uShafts;    // @param 0.0 .. 4.0 = 3.00 "light shafts"
uniform int   uShaftSteps;// @param 8 .. 48 = 28 step 1 "shaft samples"
uniform float uHaze;      // @param 0.0 .. 1.5 = 0.90 "air density"

uniform float uPalShift;  // @param 0.0 .. 1.0 = 0.08 "palette shift"
uniform float uPalWidth;  // @param 0.0 .. 1.0 = 0.32 "palette spread"
uniform vec3  uLight;     // @color = #ffd9a0 "light"
uniform float uPower;     // @param 0.0 .. 40.0 = 16.0 "light power"

uniform float uRough;     // @param 0.05 .. 1.0 = 0.48 "stone roughness"
uniform float uMetal;     // @param 0.0 .. 1.0 = 0.25 "ring metal"
uniform float uVignette;  // @param 0.0 .. 1.0 = 0.5 "vignette"

/** Material id carried out of the scene: 0 stone, 1 the metal ring. */
float gMaterial;

/**
 * The chamber. `opSmoothUnionM` is the reason the material survives the union —
 * it returns the blend factor it used, so the surface knows which of the two
 * shapes it mostly belongs to. Every other union in this repo throws that away
 * and leaves the piece with one material.
 */
float sceneSdf(vec3 p) {
    // Columns: one sector of rotational symmetry, so the cost is one column
    // however many there are.
    vec3 c = opPolarRepeat(p, uColumns);
    c.x -= uRadius;
    float column = sdHexPrism(c.xzy, vec2(uThick, 2.6));

    // Floor, and a ceiling with a hole punched through it. opSubtract takes the
    // CUTTER first: the aperture is carved out of the shell, not the other way
    // round, and getting that backwards yields a solid plug down the axis.
    float floorPlane = sdPlane(p - vec3(0.0, -1.3, 0.0), vec3(0.0, 1.0, 0.0), 0.0);
    float dome = sdSphere(p - vec3(0.0, -1.3, 0.0), 3.5);
    float aperture = sdCylinder(p - vec3(0.0, 1.6, 0.0), 3.0, uAperture);
    float ceiling = opSubtract(aperture, -dome);

    // A ring tying the columns together at the top: the second material.
    float ring = sdTorus(p - vec3(0.0, 1.15, 0.0), uRadius, uThick * 0.55);

    float blend;
    float stone = opSmoothUnion(opSmoothUnion(column, floorPlane, 0.08), ceiling, 0.10);
    float d = opSmoothUnionM(ring, stone, 0.06, blend);
    gMaterial = blend;
    return d;
}

/** Density of the air. Thicker low down, which is where haze actually sits. */
float vaultFog(vec3 p) {
    return uHaze * exp(-max(p.y + 1.3, 0.0) * 0.55);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);

    float t = uTime * uSpin;
    vec3 eye = vec3(sin(t) * uDist, uEyeY, cos(t) * uDist);
    vec3 ro, rd;
    float fov = uFov;
    rmCamera(uv, eye, vec3(0.0, uLookY, 0.0), vec3(0.0, 1.0, 0.0), fov, ro, rd);

    // The light is the aperture: a source above, straight down the axis.
    //
    // Just above the opening, and close enough that inverse-square blows the
    // stone immediately around it out to white. That was tried the other way —
    // the lamp moved to y = 6 with the power raised to compensate — and the
    // result was a uniformly dim room with no light in it. An oculus IS clipped
    // relative to the interior it lights; that contrast is the subject.
    vec3 lightPos = vec3(0.0, 3.1, 0.0);

    float foot = rmFootprint(pxSize(), fov);
    int steps = uQuality > 0 ? 140 : 90;
    RmHit h = rmMarch(ro, rd, 0.02, 24.0, steps, foot, 0.85);

    // The miss path is what the aperture opens ONTO. Left black, a hole in a
    // ceiling reads as a hole in the geometry rather than as daylight, and the
    // shafts have nothing to be shafts of.
    vec3 outside = uLight * uPower * 0.10;
    vec3 col = h.hit ? vec3(0.0) : outside;
    float tEnd = h.hit ? h.t : 24.0;

    if (h.hit) {
        vec3 p = ro + rd * h.t;
        vec3 n = rmNormal(p, max(foot * h.t, 1e-4));
        vec3 v = -rd;
        vec3 toLight = lightPos - p;
        float dist = length(toLight);
        vec3 l = toLight / dist;

        // gMaterial is written by sceneSdf; re-evaluate at the surface so it
        // describes THIS point rather than wherever the marcher stopped last.
        sceneSdf(p);
        float isRing = sat(1.0 - gMaterial);

        // The one place a cosine palette earns its keep: a smooth ramp with no
        // lookup table and no banding, driven here by height so the chamber
        // shifts colour from floor to ceiling.
        vec3 stoneCol = colCosPalette(
            p.y * 0.12 + uPalShift,
            vec3(0.34, 0.30, 0.29),
            vec3(uPalWidth),
            vec3(1.0, 0.92, 0.80),
            vec3(0.0, 0.15, 0.30));
        vec3 albedo = mix(stoneCol, vec3(0.62, 0.52, 0.36), isRing);
        ShMaterial mat = shMaterial(albedo, mix(uRough, 0.22, isRing), uMetal * isRing);

        float ao = rmAo(p, n, 0.45);
        float sh = rmSoftShadow(p + n * 0.01, l, 0.02, dist, 16.0, 40);
        // Inverse square, because the light is a lamp in a room rather than a sun.
        vec3 radiance = uLight * uPower * sh / max(dist * dist, 0.25);
        col = shDirect(mat, n, v, l, radiance);
        col += shAmbient(mat, n, v, uLight * 0.05 * ao, uLight * 0.04 * ao);
    }

    // --- single scattering: the shafts --------------------------------------
    //
    // Walk the view ray and ask, at each step, how much of the lamp reaches
    // that point. Where a column blocks it the air stays dark; where the
    // aperture lets it through, a shaft appears. This is why the piece has an
    // aperture at all.
    //
    // Sample positions are JITTERED per sample using paRand(), not fixed. A
    // fixed offset makes the classic banded fan of concentric shells; jittering
    // turns that into noise, which the supersampling loop then integrates away
    // — the same trick the spectral sampling in 002 uses, for the same reason.
    {
        int n = uQuality > 0 ? uShaftSteps + uShaftSteps / 2 : uShaftSteps;
        float far = min(tEnd, 14.0);
        float dt = far / float(n);
        vec3 scatter = vec3(0.0);
        for (int i = 0; i < n; ++i) {
            float s = (float(i) + paRand()) * dt;
            vec3 p = ro + rd * s;
            vec3 toLight = lightPos - p;
            float dist = length(toLight);
            vec3 l = toLight / dist;
            float vis = rmSoftShadow(p, l, 0.05, dist, 8.0, 20);
            float density = vaultFog(p);
            scatter += uLight * vis * density * dt / max(dist * dist, 0.25);
        }
        // The coefficient is small because the integral is not: twenty-odd
        // samples over fourteen units, each divided by a squared distance that
        // is often well under one, adds up fast. The first version used 0.08
        // and returned a white frame.
        col += scatter * uShafts * uPower * 0.010;
    }

    col *= mix(1.0, smoothstep(1.30, 0.20, length(uv)), uVignette);
    fragColor = vec4(col, 1.0);
}
