#pragma once
#include "core/const.glsl"
#include "core/math.glsl"

// Transmissive materials. Prefix `opt` (SDF operators already own `op`).
//
// The thing that makes rendered glass look like glass is not the refraction —
// it is dispersion and absorption. A single-IOR refraction reads as clear
// plastic. Splitting the index by wavelength and attenuating by path length is
// what produces the coloured fringes and the deep interior tint that the eye
// reads as "glass".

/** Schlick's approximation. f0 = ((n1-n2)/(n1+n2))^2; ~0.04 for air/glass. */
float optFresnelSchlick(float cosTheta, float f0) {
    float m = sat(1.0 - cosTheta);
    float m2 = m * m;
    return f0 + (1.0 - f0) * m2 * m2 * m;
}

/**
 * Exact unpolarised Fresnel reflectance for a dielectric interface.
 * `eta` is n_incident / n_transmitted. Returns 1.0 under total internal
 * reflection, which Schlick cannot represent — and TIR is exactly what makes
 * the inside of a glass object bright and complicated.
 */
float optFresnelDielectric(float cosI, float eta) {
    float s2 = eta * eta * (1.0 - cosI * cosI);
    if (s2 >= 1.0) return 1.0;
    float cosT = sqrt(1.0 - s2);
    float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
    float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
    return 0.5 * (rs * rs + rp * rp);
}

/**
 * refract() returns the zero vector on total internal reflection, which is easy
 * to use by accident and shows up as black pixels. This says so instead.
 */
bool optRefract(vec3 incident, vec3 normal, float eta, out vec3 transmitted) {
    float cosI = dot(-incident, normal);
    float s2 = eta * eta * (1.0 - cosI * cosI);
    if (s2 >= 1.0) {
        transmitted = reflect(incident, normal);
        return false;
    }
    transmitted = eta * incident + (eta * cosI - sqrt(1.0 - s2)) * normal;
    return true;
}

/** Beer-Lambert attenuation over a path of length `dist` through the medium. */
vec3 optBeer(vec3 absorption, float dist) {
    return exp(-absorption * dist);
}

/**
 * Cauchy's dispersion relation, n(l) = a + b / l^2, with l in micrometres.
 * a ~= 1.5, b ~= 0.004 is ordinary crown glass; raising b exaggerates the
 * rainbow without changing the overall bending.
 */
float optIorCauchy(float a, float b, float nm) {
    float um = nm * 1e-3;
    return a + b / (um * um);
}

/** Uniform wavelength in the visible band, for stochastic spectral rendering. */
float optSampleWavelength(float u) { return mix(380.0, 730.0, u); }

float optGauss(float x, float mu, float s1, float s2) {
    float t = (x - mu) / (x < mu ? s1 : s2);
    return exp(-0.5 * t * t);
}

/** Multi-lobe Gaussian fit to the CIE 1931 observer (Wyman et al. 2013). */
vec3 optWavelengthToXyz(float nm) {
    return vec3(
        1.056 * optGauss(nm, 599.8, 37.9, 31.0)
      + 0.362 * optGauss(nm, 442.0, 16.0, 26.7)
      - 0.065 * optGauss(nm, 501.1, 20.4, 26.2),
        0.821 * optGauss(nm, 568.8, 46.9, 40.5)
      + 0.286 * optGauss(nm, 530.9, 16.3, 31.1),
        1.217 * optGauss(nm, 437.0, 11.8, 36.0)
      + 0.681 * optGauss(nm, 459.0, 26.0, 13.8));
}

vec3 optXyzToLinearSrgb(vec3 c) {
    return vec3(
         3.2404542 * c.x - 1.5371385 * c.y - 0.4985314 * c.z,
        -0.9692660 * c.x + 1.8760108 * c.y + 0.0415560 * c.z,
         0.0556434 * c.x - 0.2040259 * c.y + 1.0572252 * c.z);
}

/**
 * Per-channel normalisation so that averaging optWavelengthToLinearSrgb over
 * wavelengths sampled uniformly across [380, 730] integrates to white. Without
 * it a dispersed white highlight comes back dim and green. Computed by
 * numerically integrating the fits above AFTER the same per-channel clamp
 * applied below — integrating the unclamped response instead gives values
 * around (2.73, 3.45, 3.61), which tint every dispersed highlight warm and
 * would be near-impossible to attribute by eye. test/optics.test.ts re-derives
 * this and fails if the two ever drift apart.
 */
const vec3 OPT_SPECTRAL_NORM = vec3(1.986919, 3.033854, 3.202107);

/** Linear-sRGB response of a single wavelength, normalised as described. */
vec3 optWavelengthToLinearSrgb(float nm) {
    return max(optXyzToLinearSrgb(optWavelengthToXyz(nm)), 0.0) * OPT_SPECTRAL_NORM;
}
