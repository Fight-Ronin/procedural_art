// 011 — Mycelium, trail map
//
// Decay and diffuse, then add this step's deposit. The two together are what
// make the model a transport network rather than a drawing of paths: diffusion
// lets a trail attract agents from beside it, and decay means a path that stops
// being used disappears, so the network has to keep being paid for.
//
// The diffusion is a 3x3 box blur, which is the cheapest thing that is actually
// isotropic enough. A 5-tap plus-shaped kernel is cheaper and visibly square:
// it diffuses along the axes faster than along the diagonals, and the networks
// grow with a preference for horizontal and vertical that is very hard to
// unsee once noticed.

#include "core/math.glsl"

uniform sampler2D uDeposit;  // @buffer deposit "this step's deposits"
uniform sampler2D uTrail;    // @buffer trail   "previous trail"

uniform float uDecay;        // @param 0.80 .. 0.999 = 0.90 "retention"
uniform float uDiffuse;      // @param 0.0 .. 1.0 = 0.55 "diffusion"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    ivec2 c = ivec2(fragCoord);

    if (uInit == 1) {
        fragColor = vec4(0.0);
        return;
    }

    // paWrap is toroidal, matching agWrap: the field has no edges, so neither
    // does the blur. A clamped blur builds a bright rim because the border
    // texels average fewer neighbours.
    vec4 sum = vec4(0.0);
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            sum += paWrap(uTrail, c + ivec2(x, y));
        }
    }
    vec4 blurred = sum / 9.0;
    vec4 prev = mix(paWrap(uTrail, c), blurred, uDiffuse);

    fragColor = prev * uDecay + texelFetch(uDeposit, c, 0);
}
