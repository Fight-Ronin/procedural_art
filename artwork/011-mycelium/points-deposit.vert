// 011 — Mycelium, deposit
//
// THIS is the pass the scatter machinery was built for, and the one 010 did not
// exercise: the vertex shader reads the agent buffer to find out where its
// point goes. 010's positions came from arithmetic on the index, so the whole
// "a point pass can read a simulation" half of the design was still a claim.
//
// The read happens in a VERTEX shader, which is only possible because WebGL2
// guarantees vertex texture units (32 on the reference renderer). That is worth
// stating because the WebGL1-era answer — a transform-feedback ping-pong, or
// reading back to the CPU — would have been a great deal of machinery for the
// same result.

#include "core/math.glsl"
#include "agent/step.glsl"

uniform sampler2D uAgents;  // @buffer agents "agent state"

uniform float uDrop;        // @param 0.02 .. 1.5 = 0.30 "deposit"
uniform float uHue;         // @param 0.0 .. 1.0 = 0.35 "hue spread"

void mainPoint(int index, out vec2 pos, out float size, out vec4 deposit) {
    ivec2 res = textureSize(uAgents, 0);
    // The agent grid is `size` texels on its SHORT side and follows the output
    // aspect, so its texel count is always at least size*size — meta.json sets
    // count to exactly that, and the modulo is a belt-and-braces guard rather
    // than something that fires at any aspect the piece is actually rendered at.
    int n = max(res.x * res.y, 1);
    int i = index % n;
    vec4 st = texelFetch(uAgents, ivec2(i % res.x, i / res.x), 0);

    // The agent's position is in trail-map texels; the point pass wants art
    // space. uFullRes here is the DEPOSIT grid, which is the same shape as the
    // trail, so the conversion is the inverse of artCoord.
    vec2 texel = st.xy;
    pos = (texel - 0.5 * uFullRes) / min(uFullRes.x, uFullRes.y);

    size = 1.0;
    // Red carries the trail itself — it is what the agents sense next step, so
    // it must be the honest scalar. Green carries the agent's phase weighted by
    // the same amount, so dividing G by R downstream gives the deposit-weighted
    // mean phase of whatever passed through: a colour that follows traffic
    // rather than position.
    deposit = vec4(uDrop, uDrop * st.w * uHue, 0.0, 0.0);
}
