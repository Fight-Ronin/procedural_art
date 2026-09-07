/**
 * The viz-owned glue around every artwork shader.
 *
 * Why this exists: basics/ is a library of PURE functions — no uniform reads,
 * no texture sampling — so it stays portable to WebGPU or desktop GL later.
 * Everything impure (uniforms, the sampling loop, the single sRGB encode at the
 * very end) lives here, in viz, where it belongs.
 *
 * Four properties fall out of this for free, in every artwork, without the
 * artwork having to ask:
 *   1. tiled high-resolution export works (uTileOrigin / uFullRes)
 *   2. export-quality supersampling works (uSpp + Halton jitter)
 *   3. colour is linear everywhere and encoded exactly once
 *   4. every sample carries an ordinal and a decorrelated RNG, so stochastic
 *      effects — spectral dispersion, depth of field, area lights, motion
 *      blur, path-traced glass — are integrated by the same loop
 */

/** Must be line 1 of the shader. Never passed through the include resolver. */
export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;`;

export const PREAMBLE = `
#include "hash/hash.glsl"
#include "sample/halton.glsl"
#include "color/spaces.glsl"

// ---- uniforms owned by viz -------------------------------------------------
uniform vec2  uFullRes;     // full output resolution in px (NOT the framebuffer)
uniform vec2  uTileOrigin;  // px offset of this tile within the full output
uniform float uTime;        // seconds; ALWAYS uFrame / fps, never wall-clock
uniform int   uFrame;
uniform int   uSeed;
uniform int   uSpp;         // samples per pixel in THIS draw
uniform int   uSampleBase;  // ordinal of this draw's first sample
uniform int   uQuality;     // 0 = preview, 1 = final; gates march/sample counts
uniform vec4  uMouse;       // xy = current px, zw = last click px

// Progressive accumulation. The artwork pass writes an UNNORMALISED linear sum
// into a float target; the resolve pass divides and encodes. Nothing here is
// the artwork's business.
uniform sampler2D uAccumTex;
uniform int       uAccumEnable;

// Simulation passes. uInit is 1 on the step that seeds the state and 0 forever
// after; a stateful pass branches on it rather than needing a second shader.
uniform int uInit;
uniform int uSubstep;
uniform int uSubsteps;

out vec4 pa_fragColor;

// ---- per-sample state, set by the epilogue before each mainImage() ---------
// paSample is a GLOBALLY MONOTONIC ordinal, not an index within this draw.
// That is deliberate: an artwork written against it behaves identically whether
// its samples come from one draw's uSpp loop or accumulate across frames, so
// progressive refinement can be added later without touching any artwork.
int  paSample;
vec2 paPixel;
uint paRngState;

void paSeedRng(vec2 pixel, int ordinal, int seed) {
    paRngState = hashU33(uvec3(
        floatBitsToUint(pixel.x),
        floatBitsToUint(pixel.y),
        uint(ordinal) * 9781u + uint(seed) * 6151u)).x;
}

/** Uniform in [0,1). Advances the per-sample stream. */
float paRand()  { paRngState = hashU11(paRngState); return hashUnit(paRngState); }
vec2  paRand2() { return vec2(paRand(), paRand()); }
vec3  paRand3() { return vec3(paRand(), paRand(), paRand()); }

/**
 * Stratified sample in [0,1) for one dimension, decorrelated between pixels.
 *
 * White noise from paRand() converges as 1/sqrt(N), which for spectral work
 * means visible colour speckle even at high spp. This walks a low-discrepancy
 * sequence over the sample ordinal and rotates it by a per-pixel offset
 * (Cranley-Patterson), so each pixel covers the domain evenly while neighbours
 * use different points — the residual error becomes high-frequency texture
 * instead of banding, and converges far faster.
 *
 * Pass a small prime as the base. 2 and 3 are already used for pixel jitter,
 * so start at 5 for the artwork's own dimensions. (No backticks anywhere in the
 * GLSL below: it lives inside a JS template literal and they would end it.)
 */
float paStrat(int base) {
    return fract(smpHalton(paSample + 1, base) + hash21(paPixel + float(base) * 17.13));
}

/** Cosine-free uniform direction on the sphere. */
vec3 paRandDir() {
    float z = paRand() * 2.0 - 1.0;
    float a = paRand() * 6.283185307179586;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), r * sin(a), z);
}

// ---- resolution-independent coordinates ------------------------------------
// Short side normalised to 1.0, origin at centre. Every artwork works in this
// space so that 512px preview and 8000px print are the same picture.
vec2 artCoord(vec2 fragCoord) {
    return (fragCoord - 0.5 * uFullRes) / min(uFullRes.x, uFullRes.y);
}

// Art-space size of one output pixel. Use this (or fwidth) for antialiasing
// widths, and as the cone footprint for raymarching. Never hardcode a pixel
// count.
float pxSize() {
    return 1.0 / min(uFullRes.x, uFullRes.y);
}

// ---- reading other passes ---------------------------------------------------

/** Exact texel of a buffer, wrapped toroidally. The right read for a stencil. */
vec4 paWrap(sampler2D buf, ivec2 coord) {
    ivec2 res = textureSize(buf, 0);
    return texelFetch(buf, (coord % res + res) % res, 0);
}

/**
 * Bilinear read of a float buffer, done by hand.
 *
 * RGBA32F is not filterable without OES_texture_float_linear, so the targets
 * are NEAREST and interpolation happens here. This is what lets a simulation
 * run at half resolution and still be displayed — or printed — smoothly.
 */
vec4 paBilinear(sampler2D buf, vec2 uv) {
    vec2 res = vec2(textureSize(buf, 0));
    vec2 p = uv * res - 0.5;
    vec2 f = fract(p);
    ivec2 i = ivec2(floor(p));
    vec4 a = paWrap(buf, i + ivec2(0, 0));
    vec4 b = paWrap(buf, i + ivec2(1, 0));
    vec4 c = paWrap(buf, i + ivec2(0, 1));
    vec4 d = paWrap(buf, i + ivec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** Normalised coordinates of this fragment within the current target. */
vec2 paUv(vec2 fragCoord) { return fragCoord / uFullRes; }

// ---- ShaderToy aliases, so pasted references work while studying -----------
#define iTime uTime
#define iFrame uFrame
#define iMouse uMouse
#define iResolution vec3(uFullRes, 1.0)
`;

/** Appended after the artwork's mainImage() in the final image pass. */
export const EPILOGUE_IMAGE = `
void main() {
    vec2 pix = floor(gl_FragCoord.xy) + uTileOrigin;
    paPixel = pix;
    int spp = max(uSpp, 1);
    vec4 acc = vec4(0.0);
    for (int i = 0; i < spp; ++i) {
        paSample = uSampleBase + i;
        paSeedRng(pix, paSample, uSeed);
        // Always the sequence, never a special case for the first sample. That
        // keeps one draw of N samples EXACTLY equal to N draws of one, which is
        // what lets progressive accumulation converge to the same image the
        // exporter would produce. The cost is that a single-sample preview sits
        // at Halton point 1, (0.5, 0.333) — a uniform sixth-of-a-pixel offset,
        // not noise. test/render.test.ts pins the equivalence.
        vec2 jit = smpHalton23(paSample + 1);
        vec4 c = vec4(0.0);
        mainImage(c, pix + jit);
        acc += c;
    }
    // Unnormalised, still linear. Division by the total sample count and the
    // encode to display space both happen in the resolve pass, so that a run of
    // draws sums correctly and a highlight above 1.0 survives to be tonemapped.
    vec4 prev = uAccumEnable == 1
        ? texelFetch(uAccumTex, ivec2(gl_FragCoord.xy), 0)
        : vec4(0.0);
    pa_fragColor = prev + acc;
}
`;

/**
 * Appended after a buffer pass's mainImage().
 *
 * No sampling loop and no accumulation: a simulation step is exactly one
 * evaluation per texel, and its output is state, not light. The sample ordinal
 * still advances per substep so that a stochastic rule gets fresh randomness
 * every step rather than the same field over and over.
 */
export const EPILOGUE_BUFFER = `
void main() {
    vec2 pix = floor(gl_FragCoord.xy);
    paPixel = pix;
    paSample = uFrame * max(uSubsteps, 1) + uSubstep;
    paSeedRng(pix, paSample, uSeed);
    vec4 c = vec4(0.0);
    mainImage(c, pix + 0.5);
    pa_fragColor = c;
}
`;

/**
 * The resolve pass: average the accumulator, then apply the WHOLE display
 * transform — exposure, tonemap, sRGB encode, dither — in that order.
 *
 * It goes through the include resolver like everything else so that
 * colLinearToSrgb has exactly ONE definition in the repo. Inlining the transfer
 * function here would be four lines and a silent drift waiting to happen.
 *
 * THE TONEMAP USED TO LIVE IN THE ARTWORK, and moving it here fixes a real bug
 * rather than tidying one. Every piece ended `mainImage` with
 * `colTonemapAces(...)`, so the curve was applied PER SAMPLE and the results
 * were then averaged. Tonemaps are concave, so by Jensen the average of the
 * mapped samples is darker than the map of the averaged samples — which means
 * a pixel that is half bright edge and half dark background came out darker
 * than the light arriving there, by an amount that depends on how the edge
 * happened to fall across the sample pattern. That is the same mistake 007
 * exposed in miniature, generalised to every radiometric piece.
 *
 * Two other things follow from the accumulator now holding real linear
 * radiance rather than display-referred colour:
 *
 *   * the float targets finally carry the HDR headroom they were built for.
 *     Before this, `mainImage` clamped to [0,1] before anything was summed, so
 *     "values above 1.0 survive to be tonemapped" was true of the mechanism
 *     and false of every piece using it.
 *   * exposure and tonemap become adjustable AFTER the fact, on an image that
 *     is already converged, which is what makes them useful.
 *
 * The transform is chosen per piece in meta.json's `display` block; viz turns
 * that into two ordinary parameters, so the GUI, the URL hash and presets all
 * carry it with no extra machinery.
 */
export const RESOLVE_SOURCE = `#version 300 es
precision highp float;

#include "color/spaces.glsl"
#include "color/dither.glsl"
#include "color/tonemap.glsl"

uniform sampler2D uAccum;
uniform float uInvSamples;
// The tile's offset within the full output. The accumulator this pass reads is
// tile-sized, so gl_FragCoord here is tile-local; anything keyed on position
// must add this or a tiled export stops matching an untiled one.
uniform vec2 uTileOrigin;
// One output step, in display units. Zero disables dithering entirely.
uniform float uDitherLsb;

// The display transform. 0 none, 1 ACES, 2 Reinhard — see PA_TONEMAP in
// visualization/piece.ts, which is the one place the names are mapped.
uniform float uDisplayExposure;
uniform int   uDisplayTonemap;

// Bloom, added in linear light before the transform. The texture is a whole
// frame at an absolute size, identical for every tile — see BLOOM_SOURCE.
uniform sampler2D uBloomTex;
uniform float uBloomStrength;
// Needed to place this tile within the full frame. Zero strength means the
// texture is never sampled, so a piece without bloom pays nothing.
uniform vec2 uFullRes;

out vec4 pa_fragColor;

/**
 * Bilinear read, CLAMPED at the edges.
 *
 * By hand because RGBA32F is not filterable, and clamped rather than wrapped
 * because the preamble's paBilinear is toroidal — right for a simulation on a
 * torus, wrong here, where it would spill a bright right edge onto the left of
 * the picture.
 */
vec3 resolveBloom(vec2 uv) {
    vec2 res = vec2(textureSize(uBloomTex, 0));
    vec2 p = uv * res - 0.5;
    vec2 f = fract(p);
    ivec2 i = ivec2(floor(p));
    ivec2 hi = ivec2(res) - 1;
    vec3 a = texelFetch(uBloomTex, clamp(i + ivec2(0, 0), ivec2(0), hi), 0).rgb;
    vec3 b = texelFetch(uBloomTex, clamp(i + ivec2(1, 0), ivec2(0), hi), 0).rgb;
    vec3 c = texelFetch(uBloomTex, clamp(i + ivec2(0, 1), ivec2(0), hi), 0).rgb;
    vec3 d = texelFetch(uBloomTex, clamp(i + ivec2(1, 1), ivec2(0), hi), 0).rgb;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vec4 s = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0) * uInvSamples;

    if (uBloomStrength > 0.0) {
        // The ABSOLUTE pixel, exactly like the dither: a tile's gl_FragCoord is
        // tile-local, so sampling on it would give every tile the top-left
        // corner of the halo.
        vec2 uv = (floor(gl_FragCoord.xy) + 0.5 + uTileOrigin) / uFullRes;
        s.rgb += uBloomStrength * resolveBloom(uv);
    }

    vec3 lin = colExposure(s.rgb, uDisplayExposure);
    if (uDisplayTonemap == 1)      lin = colTonemapAces(lin);
    else if (uDisplayTonemap == 2) lin = colTonemapReinhard(lin, 2.0);
    // 0 leaves it alone. That is the right answer for a piece whose colours are
    // already display-referred — a flat graphic has no highlight to roll off,
    // and running a concave curve over its coverage blending is exactly the
    // resolution-dependent ink the tonemap note above describes.

    vec3 display = colLinearToSrgb(lin);
    display = colDither(display, floor(gl_FragCoord.xy) + uTileOrigin, uDitherLsb);
    pa_fragColor = vec4(display, s.a);
}
`;

/**
 * The bloom pass: extract highlights, then blur them, on a SMALL WHOLE-FRAME
 * target whose size is absolute.
 *
 * Post-processing and tiled export are in genuine conflict — a spatial kernel
 * reads neighbouring pixels, so a tile cannot be rendered independently and
 * byte-identical export stops being true. The way out is the move this repo
 * already made for simulation grids: size the buffer in TEXELS ON THE SHORT
 * SIDE, absolutely, and render it once for the whole frame before any tile.
 * Every tile then samples the identical texture, so nothing a tile can observe
 * changes with the tiling, and the guarantee survives intact.
 *
 * It costs an approximation, and the approximation is free: bloom is a wide,
 * low-frequency halo. Computing it from a 256px render of the frame and
 * sampling it bilinearly at 4000px is what production renderers do with a mip
 * pyramid, for the same reason. What it buys is that the halo is identical at
 * every output size — the same resolution-independence argument as basics/aa,
 * arrived at from the opposite direction.
 *
 * Weights are the binomial (1,4,6,4,1)/16, applied separably. Taps land on
 * exact texel centres because the targets are NEAREST — RGBA32F is not
 * filterable — so the stride is in whole texels and doubles per iteration.
 */
export const BLOOM_SOURCE = `#version 300 es
precision highp float;

#include "color/spaces.glsl"

uniform sampler2D uSrc;
// Sample offset in TEXELS: (stride, 0) horizontally then (0, stride).
uniform vec2  uStep;
// 1 on the first pass, which keeps only what is above the threshold.
uniform int   uExtract;
uniform float uThreshold;
// The source is drawn with several samples per pixel and the epilogue writes
// their SUM, so the extract pass divides. A stochastic piece rendered at one
// sample would have its halo built out of speckle — thresholding noise keeps
// whichever samples happened to land bright, which is a bias, not a highlight.
uniform float uInvSamples;

out vec4 pa_fragColor;

void main() {
    vec2 res = vec2(textureSize(uSrc, 0));
    vec2 uv = gl_FragCoord.xy / res;

    if (uExtract == 1) {
        vec3 c = texture(uSrc, uv).rgb * uInvSamples;
        // Scale by how far the luminance is over the threshold rather than
        // subtracting per channel, which would shift the hue of every
        // highlight towards whichever channel happened to be brightest.
        //
        // LINEAR luminance, not Oklab lightness. Oklab is a cube root of the
        // radiance, built to describe what a display can show, so it squashes
        // precisely the above-1 range a highlight occupies: 008's hottest cores
        // read 1.88 in linear red and 1.15 in Oklab L, and thresholding the
        // latter at 1.0 kept a thirteenth of the energy — a halo measurably
        // indistinguishable from none.
        float l = colLumaLinear(c);
        pa_fragColor = vec4(c * (max(l - uThreshold, 0.0) / max(l, 1.0e-4)), 1.0);
        return;
    }

    vec2 d = uStep / res;
    vec3 sum = texture(uSrc, uv - 2.0 * d).rgb * 0.0625
             + texture(uSrc, uv - d).rgb       * 0.25
             + texture(uSrc, uv).rgb           * 0.375
             + texture(uSrc, uv + d).rgb       * 0.25
             + texture(uSrc, uv + 2.0 * d).rgb * 0.0625;
    pa_fragColor = vec4(sum, 1.0);
}
`;

/** Sentinel the resolver sees; the reader maps it back to the artwork file. */
export const USER_SPEC = '<artwork>';

/**
 * Source string handed to resolveIncludes(). The artwork is pulled in as an
 * ordinary #include so its lines land in the source map under their real path.
 */
export type PassKind = 'image' | 'buffer';

export function buildEntrySource(kind: PassKind = 'image'): string {
  return [
    PRELUDE,
    PREAMBLE,
    `#include "${USER_SPEC}"`,
    kind === 'buffer' ? EPILOGUE_BUFFER : EPILOGUE_IMAGE,
  ].join('\n');
}

/** Uniform names viz sets on every program. */
export const VIZ_UNIFORMS = [
  'uFullRes',
  'uTileOrigin',
  'uTime',
  'uFrame',
  'uSeed',
  'uSpp',
  'uSampleBase',
  'uQuality',
  'uMouse',
  'uAccumTex',
  'uAccumEnable',
  'uInit',
  'uSubstep',
  'uSubsteps',
] as const;
