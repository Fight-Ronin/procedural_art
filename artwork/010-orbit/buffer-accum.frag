// 010 — Orbit, accumulation pass
//
// A gather pass whose entire job is to remember what the scatter pass did. It
// reads ITSELF and the deposit, which is the ordinary feedback the chain already
// supported; the only new thing upstream is where the deposit comes from.
//
// Kept separate from the point pass on purpose. The alternative — letting the
// scatter pass blend into an uncleared target — is one fewer buffer and much
// worse: "how many orbits are in this picture" would then depend on how many
// times the chain happened to run, which is not a question a still render, a
// tile, a sequence resume and a preview can all answer the same way.

#include "core/math.glsl"

uniform sampler2D uDeposit;  // @buffer plot "this frame's orbits"
uniform sampler2D uHist;     // @buffer accum "everything so far"

uniform float uDecay;        // @param 0.9 .. 1.0 = 0.95 "retention"

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    ivec2 c = ivec2(fragCoord);
    vec4 add = texelFetch(uDeposit, c, 0);
    // uInit is 1 on the seeding step and 0 forever after, so frame 0 holds
    // exactly one frame of orbits rather than one frame plus whatever was in
    // the texture when it was allocated.
    vec4 prev = uInit == 1 ? vec4(0.0) : texelFetch(uHist, c, 0) * uDecay;
    fragColor = prev + add;
}
