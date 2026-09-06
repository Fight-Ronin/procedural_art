// 003 — Coalesce · simulation pass
//
// Gray-Scott reaction-diffusion on a torus. Two chemicals: A is fed in and
// consumed, B is produced autocatalytically and removed. The whole zoo of
// patterns — spots, stripes, worms, mitosis, solitons — is this one rule under
// different feed and kill rates.
//
// The feed rate carries a spatial gradient, so a single frame contains several
// regimes at once instead of one uniform texture. That is almost entirely what
// separates an interesting Gray-Scott image from a wallpaper — but the gradient
// has to stay narrow: push it far enough and one end of the domain leaves the
// region where B survives at all, and that half of the picture goes empty.
//
// Defaults sit at F=0.0545, k=0.062 — Karl Sims' mitosis point, where a spot
// grows until it splits and the products split again until they fill the frame.
// Nearby values are deceptive: F=0.0367, k=0.0649 with the same diffusion rates
// settles into stable rings that never multiply, which reads as a dead picture
// no matter how long it runs. The regime, not the step count, is what decides
// whether the frame fills.

#include "core/math.glsl"
#include "hash/hash.glsl"

uniform sampler2D uState;  // @buffer a "previous state"

uniform float uFeed;     // @param 0.010 .. 0.090 = 0.0545 "feed"
uniform float uKill;     // @param 0.045 .. 0.075 = 0.0620 "kill"
uniform float uGradient; // @param 0.0 .. 1.0 = 0.12 "feed gradient"
uniform float uDiffA;    // @param 0.4 .. 1.4 = 1.0 "diffusion A"
uniform float uDiffB;    // @param 0.1 .. 0.9 = 0.48 "diffusion B"
uniform float uDt;       // @param 0.2 .. 1.4 = 1.0 "time step"
uniform int   uSeedN;    // @param 1 .. 48 = 16 step 1 "seed blobs"
uniform float uSeedSize; // @param 0.004 .. 0.080 = 0.022 "seed size"

/** Distance on the torus, so seeds near an edge are not cut in half. */
float wrapDist(vec2 a, vec2 b) {
    vec2 d = abs(a - b);
    return length(min(d, 1.0 - d));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = paUv(fragCoord);

    // uInit is 1 for exactly one step after a reset. Branching here beats a
    // second shader file: the seeding rule and the update rule share the
    // parameters and the coordinate conventions.
    if (uInit == 1) {
        float b = 0.0;
        for (int i = 0; i < uSeedN; ++i) {
            vec2 q = hash22s(vec2(float(i) * 3.7, 11.3), uSeed);
            b = max(b, smoothstep(uSeedSize, uSeedSize * 0.35, wrapDist(uv, q)));
        }
        fragColor = vec4(1.0, b, 0.0, 1.0);
        return;
    }

    ivec2 c = ivec2(fragCoord);
    vec2 s = paWrap(uState, c).xy;

    // Nine-point Laplacian: orthogonal 0.2, diagonal 0.05, centre -1. The
    // diagonal terms matter — a five-point stencil leaves a visible square
    // anisotropy that grows into axis-aligned artefacts over thousands of steps.
    vec2 lap = -s;
    lap += 0.20 * (paWrap(uState, c + ivec2( 1,  0)).xy
                 + paWrap(uState, c + ivec2(-1,  0)).xy
                 + paWrap(uState, c + ivec2( 0,  1)).xy
                 + paWrap(uState, c + ivec2( 0, -1)).xy);
    lap += 0.05 * (paWrap(uState, c + ivec2( 1,  1)).xy
                 + paWrap(uState, c + ivec2(-1,  1)).xy
                 + paWrap(uState, c + ivec2( 1, -1)).xy
                 + paWrap(uState, c + ivec2(-1, -1)).xy);

    float a = s.x;
    float b = s.y;
    float reaction = a * b * b;
    float feed = uFeed * (1.0 + uGradient * (uv.x - 0.5) * 2.0);

    float na = a + (uDiffA * lap.x - reaction + feed * (1.0 - a)) * uDt;
    float nb = b + (uDiffB * lap.y + reaction - (uKill + feed) * b) * uDt;

    fragColor = vec4(sat(na), sat(nb), 0.0, 1.0);
}
