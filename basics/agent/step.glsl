#pragma once
#include "core/math.glsl"
#include "core/const.glsl"

/**
 * The agent rule from Jeff Jones' slime-mould model, minus the sensing.
 *
 * An agent has a position and a heading. Each step it samples a trail map at
 * three points ahead of it — left, centre, right — turns according to what it
 * found, moves forward, and deposits. Iterated over a few hundred thousand
 * agents this produces the transport networks everyone recognises: veins that
 * thicken where traffic concentrates, and that reorganise when the field
 * changes.
 *
 * THE SENSING IS NOT HERE, and cannot be: it reads a texture, which `basics/`
 * is forbidden to do. What IS here is everything downstream of the three
 * numbers — the turn decision, the sensor geometry, the move, the wrap — which
 * is the part with a right answer and the part that is silently wrong when it
 * is wrong. The artwork does the three texture reads and calls `agTurn`.
 *
 * That split is the same one `raymarch/march.glsl` makes with `sceneSdf` and
 * `field/flow.glsl` makes with its integrator, and for the same reason: the
 * impure step is a texture read the caller can do in one line, so the library
 * does not need a second undefined prototype to reach it.
 */

/**
 * Which way to turn, given the left, centre and right sensor readings.
 *
 * Returns +1 to turn left, -1 to turn right, 0 to carry straight on. `rnd` is
 * used only in the one case that calls for it.
 *
 * The rule looks like four arbitrary branches and is not. Each one is doing
 * something specific, and the two that get "simplified" away are the two that
 * make the networks form:
 *
 *   C strongest        -> straight. The agent is already following a trail.
 *   C weakest          -> turn RANDOMLY, not toward the better side. The agent
 *                         is straddling a ridge with the trail on both sides;
 *                         picking the stronger one is a tie-break between two
 *                         directions it cannot actually see the difference
 *                         between, and doing it deterministically makes every
 *                         agent in that situation choose alike. That
 *                         correlation is what turns a network into a set of
 *                         concentric rings.
 *   one side stronger  -> turn that way.
 *   exactly equal      -> straight, and NOT a coin flip. Equality is common at
 *                         the start, when the trail map is uniform: a coin flip
 *                         there is a random walk that never commits to a
 *                         direction, and the pattern takes far longer to
 *                         nucleate out of it.
 *
 * The naive "steer toward the largest reading" collapses all four into one. It
 * runs, it looks superficially similar for a few hundred steps, and it does not
 * make veins. `test/agent.test.ts` uses it as the control.
 */
float agTurn(vec3 lcr, float rnd) {
    float l = lcr.x;
    float c = lcr.y;
    float r = lcr.z;
    if (c > l && c > r) return 0.0;
    if (c < l && c < r) return rnd < 0.5 ? -1.0 : 1.0;
    if (r > l) return -1.0;
    if (l > r) return 1.0;
    return 0.0;
}

/** Unit heading vector. Angle 0 points along +x. */
vec2 agDir(float heading) { return vec2(cos(heading), sin(heading)); }

/**
 * Where the three sensors sit: `dist` ahead, splayed by +/- `angle`.
 *
 * Returned rather than sampled, because sampling is the caller's job. The
 * centre sensor is deliberately at the same DISTANCE as the other two rather
 * than at the agent's own position — a centre reading taken where the agent
 * already is measures its own deposit from last step, so every agent sees a
 * strong centre, decides it is on a trail, and goes straight forever.
 */
void agSensors(vec2 p, float heading, float angle, float dist,
               out vec2 left, out vec2 centre, out vec2 right) {
    left   = p + agDir(heading + angle) * dist;
    centre = p + agDir(heading) * dist;
    right  = p + agDir(heading - angle) * dist;
}

/** Advance along the heading. */
vec2 agMove(vec2 p, float heading, float speed) {
    return p + agDir(heading) * speed;
}

/**
 * Toroidal wrap into [0, size).
 *
 * A wrap rather than a bounce or a clamp. Clamping piles agents against the
 * edge into a bright border that is pure artefact; bouncing is worse, because
 * it correlates the headings of everything near the edge. The torus has no
 * boundary, so the field has no special places in it.
 */
vec2 agWrap(vec2 p, vec2 size) {
    return mod(mod(p, size) + size, size);
}

/** Same, for a heading: keeps the angle in [0, TAU) so it cannot drift away. */
float agWrapAngle(float a) {
    return mod(mod(a, TAU) + TAU, TAU);
}
