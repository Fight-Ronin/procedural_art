#pragma once
#include "core/math.glsl"
#include "noise/curl.glsl"

// Walking a point through a velocity field.
//
// WHAT IS NOT HERE, and deliberately: the accumulation loop. Line integral
// convolution — smearing a pattern along streamlines — needs to evaluate an
// arbitrary pattern at every step, and GLSL has no function pointers. The one
// sanctioned way around that in this repo is a declared prototype the artwork
// defines (`sceneSdf`), and one such hole is a design; three is a habit. So the
// artwork writes its own eight-line loop around `flowStep*` and evaluates
// whatever it likes. What lives here is the part that is genuinely shared and
// genuinely easy to get wrong: the field, and the integrator.
//
// The field is a curl, so it is divergence-free — see `noise/curl.glsl`. That
// is what makes traced paths behave like a fluid rather than like a gradient
// descent: they never all pile into the same sink.

/**
 * Velocity of the curl-noise field at `p`.
 *
 * `freq` sets the size of the eddies and `amp` sets the speed, INDEPENDENTLY.
 * Strictly, the curl of a potential fbm(p * freq) carries a factor of freq from
 * the chain rule, so raising the frequency would also speed everything up.
 * That factor is dropped here: retuning speed every time you retune scale is a
 * miserable way to find a picture. Dropping it costs nothing that matters —
 * amp * curl(psi)(freq * p) is still exactly the curl of a scalar field, namely
 * (amp / freq) * psi(freq * p), so the field remains divergence-free.
 *
 * `offset` translates the potential. Animating it moves the whole flow pattern
 * without any state, which is what keeps a flow piece a pure function of
 * (position, frame).
 */
vec2 flowVel(vec2 p, float freq, float amp, vec2 offset, int octaves) {
    return amp * nzCurl21(p * freq + offset, octaves);
}

/** One explicit Euler step. Cheapest useful integrator: one field evaluation. */
vec2 flowStepEuler(vec2 p, float dt, float freq, float amp, vec2 offset, int octaves) {
    return p + flowVel(p, freq, amp, offset, octaves) * dt;
}

/**
 * One midpoint (RK2) step: sample the velocity, step half way, sample again,
 * and use the second velocity for the whole step. Two field evaluations for
 * second-order accuracy instead of first.
 *
 * Worth it when the path itself must be right — tracking a particle, or taking
 * long steps through a field that curves sharply. Worth LESS than it looks for
 * smearing a pattern along a streamline, where the same budget spent on twice
 * as many Euler steps also buys twice as many places to sample the pattern, and
 * the extra samples improve the picture more than the extra accuracy does.
 */
vec2 flowStepRk2(vec2 p, float dt, float freq, float amp, vec2 offset, int octaves) {
    vec2 v1 = flowVel(p, freq, amp, offset, octaves);
    vec2 v2 = flowVel(p + v1 * (dt * 0.5), freq, amp, offset, octaves);
    return p + v2 * dt;
}

/**
 * Where a point ends up after `steps` of the flow. Negative `dt` traces
 * backward — asking where the material now at `p` came FROM, which is the
 * question a display pass usually wants to ask.
 */
vec2 flowTrace(vec2 p, int steps, float dt, float freq, float amp, vec2 offset, int octaves) {
    for (int i = 0; i < steps; ++i) {
        p = flowStepRk2(p, dt, freq, amp, offset, octaves);
    }
    return p;
}
