#pragma once
#include "core/const.glsl"
#include "core/math.glsl"

// A surface shading model: Cook-Torrance specular over Lambert diffuse.
//
// `raymarch/shade.glsl` has ambient occlusion, soft shadows and curvature —
// those are TERMS, things that modulate light. None of them says how a surface
// turns incoming light into outgoing light, and without that the repo could
// march an opaque object and had nothing to do with it. 002 only sidestepped it
// by being glass, which is nearly pure transmission, and even then it had to
// write its own light rig inline.
//
// Why a microfacet model rather than a hand-tuned "specular = pow(dot(r,l), n)":
// the Phong-ish version has no relationship between roughness, brightness and
// the shape of the highlight, so every material has to be re-tuned by eye for
// every light, and nothing looks consistent between two pieces. GGX ties them
// together and the results transfer.
//
// THREE PROPERTIES ARE TESTABLE and `test/shade.test.ts` tests them, because
// each corresponds to a classic mistake that still produces a plausible image:
//
//   non-negative           a lobe that goes negative somewhere is a sign error
//   reciprocal             swapping view and light must not change the answer;
//                          an asymmetric denominator is the usual cause
//   energy-conserving      integrated over the hemisphere it must not exceed 1.
//                          A missing 1/PI, or 4*n.v*n.l left out, brightens the
//                          whole picture in a way that looks like "nice punchy
//                          lighting" until two materials have to agree.
//
// Everything here is pure: no uniforms, no textures, direction vectors in, a
// colour out. The artwork owns the lights.

struct ShMaterial {
    /** Linear-light base colour. For metals this is the specular colour. */
    vec3 albedo;
    /** Perceptual roughness in [0,1]. Squared into the GGX alpha below. */
    float roughness;
    /** 0 = dielectric, 1 = conductor. Values between are for transitions only. */
    float metallic;
    /** Normal-incidence reflectance for the dielectric part. 0.04 is most things. */
    float specular;
};

ShMaterial shMaterial(vec3 albedo, float roughness, float metallic) {
    // Clamped away from zero: alpha = 0 makes the GGX denominator a delta
    // function, which in floating point is a NaN or a single blown-out pixel
    // rather than the mirror it is meant to be.
    return ShMaterial(albedo, clamp(roughness, 0.03, 1.0), sat(metallic), 0.04);
}

/** Reflectance at normal incidence: dielectrics are grey, metals are coloured. */
vec3 shF0(ShMaterial m) {
    return mix(vec3(m.specular), m.albedo, m.metallic);
}

/** Schlick's approximation to the Fresnel term. */
vec3 shFresnel(vec3 f0, float vdoth) {
    return f0 + (1.0 - f0) * pow(1.0 - sat(vdoth), 5.0);
}

/**
 * Trowbridge-Reitz (GGX) normal distribution.
 *
 * Normalised so that the integral of D(h) (n.h) over the hemisphere is 1 —
 * that is what the 1/PI is for, and dropping it is the single most common way
 * to end up with a shading model that is too bright by a factor of three.
 */
float shDistributionGgx(float ndoth, float alpha) {
    float a2 = alpha * alpha;
    float d = ndoth * ndoth * (a2 - 1.0) + 1.0;
    return a2 / max(PI * d * d, 1e-8);
}

/**
 * Smith height-correlated masking-shadowing, Schlick form.
 *
 * `k = alpha / 2` is the remapping for DIRECT light. Image-based lighting wants
 * a different one, which is why this takes alpha rather than a material — the
 * two uses do not share a constant and pretending they do darkens grazing
 * angles.
 */
float shGeometrySmith(float ndotv, float ndotl, float alpha) {
    float k = alpha * 0.5;
    float gv = ndotv / max(ndotv * (1.0 - k) + k, 1e-8);
    float gl = ndotl / max(ndotl * (1.0 - k) + k, 1e-8);
    return gv * gl;
}

/**
 * The full BRDF, per steradian. Does NOT include the cosine — multiply by
 * `n.l` yourself, or use `shDirect`.
 *
 * Keeping the cosine out is what makes the reciprocity test meaningful: the
 * BRDF is symmetric in v and l, and BRDF times n.l is not.
 */
vec3 shBrdf(ShMaterial m, vec3 n, vec3 v, vec3 l) {
    vec3 h = normalize(v + l);
    float ndotv = max(dot(n, v), 0.0);
    float ndotl = max(dot(n, l), 0.0);
    if (ndotv <= 0.0 || ndotl <= 0.0) return vec3(0.0);

    float alpha = m.roughness * m.roughness;
    float d = shDistributionGgx(max(dot(n, h), 0.0), alpha);
    float g = shGeometrySmith(ndotv, ndotl, alpha);
    vec3 f = shFresnel(shF0(m), max(dot(v, h), 0.0));

    vec3 spec = (d * g * f) / max(4.0 * ndotv * ndotl, 1e-8);

    // What the specular lobe did not reflect is available to scatter
    // diffusely, and metals have no diffuse at all. Without both factors the
    // surface emits more than it receives at grazing angles.
    vec3 kd = (vec3(1.0) - f) * (1.0 - m.metallic);
    vec3 diff = kd * m.albedo / PI;

    return diff + spec;
}

/** Outgoing radiance from one directional light of the given radiance. */
vec3 shDirect(ShMaterial m, vec3 n, vec3 v, vec3 l, vec3 radiance) {
    return shBrdf(m, n, v, l) * radiance * max(dot(n, l), 0.0);
}

/**
 * A cheap stand-in for image-based lighting: the ambient a surface picks up
 * from an environment, split the same way as the direct term.
 *
 * `irradiance` is roughly what the environment delivers to a surface facing
 * `n`, and `reflected` is what it delivers along the mirror direction. The
 * artwork supplies both by sampling its own environment function, so this stays
 * pure and the environment stays the artwork's business.
 */
vec3 shAmbient(ShMaterial m, vec3 n, vec3 v, vec3 irradiance, vec3 reflected) {
    float ndotv = max(dot(n, v), 0.0);
    vec3 f = shFresnel(shF0(m), ndotv);
    vec3 kd = (vec3(1.0) - f) * (1.0 - m.metallic);
    // Roughness dims the mirror lobe: a rough surface spreads the same energy
    // over a wider cone, so less of it comes back along any one direction.
    return kd * m.albedo * irradiance + f * reflected * (1.0 - m.roughness * 0.7);
}
