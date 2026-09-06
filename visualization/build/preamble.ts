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
 * The resolve pass: divide the accumulator by the sample count and encode.
 *
 * It goes through the include resolver like everything else so that
 * colLinearToSrgb has exactly ONE definition in the repo. Inlining the transfer
 * function here would be four lines and a silent drift waiting to happen.
 */
export const RESOLVE_SOURCE = `#version 300 es
precision highp float;

#include "color/spaces.glsl"
#include "color/dither.glsl"

uniform sampler2D uAccum;
uniform float uInvSamples;
// The tile's offset within the full output. The accumulator this pass reads is
// tile-sized, so gl_FragCoord here is tile-local; anything keyed on position
// must add this or a tiled export stops matching an untiled one.
uniform vec2 uTileOrigin;
// One output step, in display units. Zero disables dithering entirely.
uniform float uDitherLsb;

out vec4 pa_fragColor;

void main() {
    vec4 s = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0) * uInvSamples;
    vec3 display = colLinearToSrgb(s.rgb);
    display = colDither(display, floor(gl_FragCoord.xy) + uTileOrigin, uDitherLsb);
    pa_fragColor = vec4(display, s.a);
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
