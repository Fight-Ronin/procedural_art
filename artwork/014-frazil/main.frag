// 014 — Frazil · image pass
//
// The ice is drawn from WHEN it froze, not from what it is now.
//
// phi forgets: behind the tips the side branches coarsen and merge, and a late
// plate fills the gaps it grows over. The step at which each cell first froze
// (t_s, the buffer's blue channel) is written once and never revised, so it
// still holds every branch the crystal ever had. Brightness decays with the
// time since freezing — an afterglow — so the growing tips are the brightest
// thing in the picture and the trunk the darkest, and the crystal reads as
// something still happening.
//
// The physical motive is that latent heat is released at the front. Ice does
// not glow; this is a metaphor and is described as one in meta.json.
//
// Mapping t_s straight onto a ramp was measured in the prototype and rejected:
// t_s is roughly r / v_tip, so that picture is a radial gradient with a crystal
// silhouette. Decay relative to NOW puts the contrast between the front and
// the branches it has already left behind, which is where the structure is.
//
// The liquid carries the temperature field faintly: the warm envelope the
// crystal releases into the water is the cause of the branching, so it earns a
// place, but it is kept low (cubed, then scaled) — at full strength it filled
// the gaps between branches and the crystal read as one hexagonal plate.
//
// The edge is the phi = 1/2 level set of a Catmull-Rom reconstruction, with
// coverage taken from the analytic gradient in output pixels. The interface is
// a smooth profile three or four cells wide by construction, so the edge stays
// sharp at any print size; what a larger print cannot add is detail finer than
// the interface, because the simulation never had it.

#include "core/math.glsl"

uniform sampler2D uIce;     // @buffer ice "crystal"

uniform float uGlow;        // @param 0.5 .. 5.0 = 1.6 "glow"
uniform float uAfterglow;   // @param 0.05 .. 0.8 = 0.2 "afterglow"
uniform float uHalo;        // @param 0.0 .. 1.5 = 0.5 "heat halo"
uniform vec3  uFresh;       // @color = #ffedc8 "fresh ice"
uniform vec3  uCool;        // @color = #a8dfff "cooling ice"
uniform vec3  uDeep;        // @color = #98b1ff "old ice"
uniform vec3  uWater;       // @color = #0d1627 "water"

ivec2 gRes;

/** Clamped texel read: the grid has walls, so nothing wraps. */
vec4 cell(ivec2 c) {
    return texelFetch(uIce, clamp(c, ivec2(0), gRes - 1), 0);
}

/** Catmull-Rom weights and their derivatives at fraction t. */
void crWeights(float t, out vec4 w, out vec4 dw) {
    float t2 = t * t, t3 = t2 * t;
    w  = 0.5 * vec4(-t3 + 2.0 * t2 - t,
                    3.0 * t3 - 5.0 * t2 + 2.0,
                   -3.0 * t3 + 4.0 * t2 + t,
                    t3 - t2);
    dw = 0.5 * vec4(-3.0 * t2 + 4.0 * t - 1.0,
                    9.0 * t2 - 10.0 * t,
                   -9.0 * t2 + 8.0 * t + 1.0,
                    3.0 * t2 - 2.0 * t);
}

/** Uniform cubic B-spline weights at fraction t: positive, sum to 1, C2. */
vec4 bsWeights(float t) {
    float t2 = t * t, t3 = t2 * t;
    return vec4((1.0 - t) * (1.0 - t) * (1.0 - t),
                3.0 * t3 - 6.0 * t2 + 4.0,
               -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0,
                t3) / 6.0;
}

/**
 * Everything the picture reads from the grid, from ONE 4x4 neighbourhood:
 *
 *   x, y, z  phi and its gradient in grid units — Catmull-Rom, which
 *            interpolates, so the phi = 1/2 edge is where the simulation put it
 *   tf       T and t_s — cubic B-spline, which smooths
 *
 * t_s is averaged over FROZEN cells only. Unfrozen cells hold -1; averaging them
 * in would read the edge of the crystal as having frozen near time zero — the
 * oldest ice, so the darkest — and every tip would get a dark rim exactly where
 * it should be brightest.
 *
 * B-SPLINE, NOT BILINEAR, AND THE REASON IS PRINT. A 512 grid in a 4000 px still
 * is eight pixels a cell. Ice that froze late — a gap filled in as branches
 * coarsened — is young and bright among old neighbours, and bilinear over the
 * frozen cells switched which cells counted at every cell boundary: at print
 * size those patches came out as staircases. The B-spline's weights are all
 * positive, so renormalising over the frozen ones is still a proper average,
 * and it is C2, so there is no boundary to see. It also blurs t_s over about a
 * cell, which costs nothing: t_s is a time, and nothing in the picture depends
 * on it at sub-cell resolution.
 */
vec3 reconstruct(vec2 g, out vec2 tf) {
    vec2 p = g - 0.5;
    ivec2 i = ivec2(floor(p));
    vec2 f = p - floor(p);
    vec4 wx, dwx, wy, dwy;
    crWeights(f.x, wx, dwx);
    crWeights(f.y, wy, dwy);
    vec4 bx = bsWeights(f.x), by = bsWeights(f.y);
    vec3 phi = vec3(0.0);
    float t = 0.0, tsNum = 0.0, tsDen = 0.0;
    for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
            vec4 c = cell(i + ivec2(x - 1, y - 1));
            phi += c.r * vec3(wx[x] * wy[y], dwx[x] * wy[y], wx[x] * dwy[y]);
            float b = bx[x] * by[y];
            t += c.g * b;
            float k = c.b >= 0.0 ? b : 0.0;
            tsNum += c.b * k;
            tsDen += k;
        }
    }
    tf = vec2(t, tsDen > 0.0 ? tsNum / tsDen : -1.0);
    return phi;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    gRes = textureSize(uIce, 0);
    vec2 uv = fragCoord / uFullRes;
    vec2 g = uv * vec2(gRes);

    vec2 tf;
    vec3 pc = reconstruct(g, tf);
    float phi = pc.x;
    // Grid cells per output pixel, so the coverage ramp is one pixel wide at
    // every output size.
    float perPx = float(gRes.x) / uFullRes.x;
    float slope = length(pc.yz) * perPx;
    float cover = sat((phi - 0.5) / max(slope, 1e-6) + 0.5);

    float now = cell(ivec2(0)).a;

    // Afterglow: 1 on the freezing front, decaying with age relative to the
    // crystal's own lifetime — so the picture has the same contrast whether it
    // is looked at early or late.
    //
    // A POWER LAW, NOT AN EXPONENTIAL. The exponential flattened everything
    // older than about twice uAfterglow into one slate colour, so the inner
    // rings — the early weather, which is what the piece says the radius
    // records — read as a dark hole with outlines. (1 + x / 1.5)^-1.5 has the
    // same slope at the front and a long tail, so age stays legible all the way
    // in. A heavier tail (exponent 1) was tried and washed the contrast out.
    //
    // Where the cubic says ice but no cell under the pixel has frozen yet, the
    // pixel is at the very tip, overshooting by a fraction of a cell: the
    // youngest ice there is, so age 0 — not "unknown", which read as the oldest
    // and gave every tip a dark point.
    float age = tf.y >= 0.0 ? max(now - tf.y, 0.0) : 0.0;
    float glow = pow(1.0 + age / (uAfterglow * max(now, 1.0)) / 1.5, -1.5);

    // Fresh -> cooling over the first half of the decay, cooling -> deep over
    // the second. The squared upper half keeps fresh ice to a thin band at the
    // front; a linear blend spread the warm colour back along every branch.
    vec3 fresh = uFresh * uGlow;
    vec3 cool = uCool * uGlow * 0.9;
    vec3 deep = uDeep * 0.16;
    vec3 hue = glow > 0.5
        ? mix(cool, fresh, pow((glow - 0.5) / 0.5, 2.0))
        : mix(deep, cool, glow / 0.5);
    vec3 ice = hue * (0.15 + 0.85 * glow);

    // A thin luminous skin where phi passes through the interface.
    float skin = smoothstep(0.12, 0.5, phi) * (1.0 - smoothstep(0.5, 0.9, phi));
    vec3 rim = uCool * 0.48 * skin;

    vec3 water = uWater + uCool * 0.18 * uHalo * pow(sat(tf.x), 3.0);

    fragColor = vec4(mix(water, ice, cover) + rim, 1.0);
}
