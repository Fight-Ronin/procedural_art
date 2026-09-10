// 011 — Mycelium, agent state
//
// One texel per agent: xy = position in trail-map texels, z = heading, w = a
// per-agent phase used only for colour. Ordinary ping-pong feedback — this pass
// reads itself, which the chain has supported since block 5.
//
// It reads the TRAIL, which is declared after it, so it sees last step's trail.
// That is the chain's rule (a pass reading an earlier pass sees the current
// step; reading a later one, or itself, sees the previous) and it is the right
// way round here: sense, then move, then deposit, then diffuse.

#include "core/math.glsl"
#include "core/const.glsl"
#include "hash/hash.glsl"
#include "agent/step.glsl"

uniform sampler2D uAgents;  // @buffer agents "agent state"
uniform sampler2D uTrail;   // @buffer trail  "trail map"

uniform float uSenseAngle;  // @param 0.05 .. 1.6 = 0.62 "sensor angle"
uniform float uSenseDist;   // @param 1.0 .. 40.0 = 12.0 "sensor distance"
uniform float uTurn;        // @param 0.02 .. 1.2 = 0.85 "turn strength"
uniform float uSpeed;       // @param 0.2 .. 4.0 = 1.35 "speed"
uniform float uJitter;      // @param 0.0 .. 0.4 = 0.045 "heading jitter"

/**
 * Read the trail at a position given in TEXELS, wrapped toroidally.
 *
 * paBilinear takes normalised coordinates and wraps, which is exactly right:
 * the sensor lands between texels and a nearest read would quantise the turn
 * decision to the grid, making agents follow the lattice instead of the field.
 */
float senseAt(vec2 texel, vec2 res) {
    return paBilinear(uTrail, texel / res).r;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    ivec2 cell = ivec2(fragCoord);
    vec2 res = vec2(textureSize(uTrail, 0));

    if (uInit == 1) {
        // UNIFORM over the whole field, with random headings.
        //
        // The first version seeded a small central disc, on the theory that a
        // network growing outward from somewhere would settle sooner and read
        // as what it is. It does neither: the density inside the disc is enough
        // to saturate the trail immediately, so the centre becomes a solid slab
        // that nothing can sense a gradient in, and the agents that escape it
        // run outward and never turn back — radial fingers, not a network.
        //
        // Jones seeds uniformly and the reason is structural rather than
        // aesthetic. The pattern forms out of a homogeneous field by symmetry
        // breaking; giving it a centre to begin with does not accelerate that,
        // it replaces it with a different and much less interesting process.
        vec3 h = hash33(vec3(fragCoord, float(uSeed)));
        fragColor = vec4(h.xy * res, h.z * TAU, hash21(fragCoord + 19.7));
        return;
    }

    vec4 st = texelFetch(uAgents, cell, 0);
    vec2 p = st.xy;
    float heading = st.z;

    vec2 sl, sc, sr;
    agSensors(p, heading, uSenseAngle, uSenseDist, sl, sc, sr);
    vec3 lcr = vec3(senseAt(sl, res), senseAt(sc, res), senseAt(sr, res));

    // The whole point of basics/agent: the branchy part with a right answer is
    // there, and this file only supplies the three numbers.
    heading += agTurn(lcr, paRand()) * uTurn;
    // A little noise on every step, not only on the random-turn branch. Without
    // it agents that end up exactly parallel stay exactly parallel, and the
    // network gets straight segments that read as machined rather than grown.
    heading += (paRand() * 2.0 - 1.0) * uJitter;

    p = agWrap(agMove(p, heading, uSpeed), res);
    fragColor = vec4(p, agWrapAngle(heading), st.w);
}
