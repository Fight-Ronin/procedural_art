#pragma once
#include "core/const.glsl"
#include "core/math.glsl"

// The shape of a traversable wormhole, as a radius function.
//
// Every piece in this repo so far has had light travelling in straight lines.
// This directory is where that stops: a metric says how far apart two nearby
// events are, and once the answer is not Pythagoras the ray is no longer a
// parameter of a line but the solution of an equation. `metric/geodesic.glsl`
// solves it; this file is the spacetime it is solved in.
//
// THE WHOLE METRIC IS ONE FUNCTION. Morris-Thorne form:
//
//     ds^2 = -dt^2 + dl^2 + r(l)^2 (dtheta^2 + sin^2 theta dphi^2)
//
// `l` is PROPER RADIAL DISTANCE, not a coordinate radius, and that choice is
// what makes the thing numerically tractable: l runs from -infinity to
// +infinity through the throat with no coordinate singularity anywhere, so a
// ray can be integrated straight through the middle with no special case. (The
// Schwarzschild r degenerates at the horizon and needs one.) Two universes,
// one chart, one function r(l) — everything else in this directory follows from
// r and its derivative.
//
// WHICH r. The obvious choice is Ellis's r = sqrt(l^2 + a^2), which is elegant
// (its embedding surface is a catenoid, hence a minimal surface) and useless
// for a piece about travelling THROUGH something: its throat has zero length,
// so the far universe goes from a small disc to a full hemisphere in an
// instant. The three-parameter form below — from the Interstellar visual
// effects paper, James, von Tunzelmann, Franklin & Thorne, Am. J. Phys. 83
// (2015) — has an explicit cylindrical section, so "inside the throat" is a
// place with a length rather than a moment:
//
//     |l| <= cyl :  r = rho                                    (a true cylinder)
//     |l| >  cyl :  r = rho + M [ x atan x - ln(1+x^2)/2 ],  x = 2(|l|-cyl)/(pi M)
//
// and the slope collapses to something much simpler than the profile it comes
// from, because the two halves of d/dx [x atan x - ln(1+x^2)/2] cancel:
//
//     dr/dl = sign(l) (2/pi) atan x
//
// Three properties of that expression are load-bearing and all three are
// checked in `test/metric.test.ts` rather than believed:
//
//   It is ZERO at |l| = cyl, so the cylinder joins the flare smoothly — r is C1
//   and a ray crossing the mouth feels no kink. (r'' does jump there, which is
//   why the marcher below uses a fixed step: an adaptive one chatters at the
//   mouth, and the chatter is a ring in the picture at exactly the radius the
//   eye is already looking at.)
//
//   It tends to +-1 as |l| grows, so r -> |l| - const: the far field is flat and
//   a sky can be hung on it.
//
//   Its magnitude is strictly BELOW 1 everywhere, which is the flare-out
//   condition. Geometrically it is the statement that the embedding profile
//   dz/dl = sqrt(1 - (dr/dl)^2) stays real — that the surface can be drawn at
//   all. A shape violating it is not a wormhole that looks wrong, it is not a
//   shape.

/**
 * The paper's ratio between lensing width and the mass parameter M.
 *
 * `lens` is exposed instead of M because it is the knob with a picture attached:
 * it is roughly the width of the band of sky around the throat that is visibly
 * bent. The constant only sets what one unit of that knob means — an error in
 * it rescales the control, it does not change the family of shapes.
 */
const float MT_LENS_W = 1.42953;

/**
 * Throat radius `rho`, throat LENGTH (not half-length) `length`, lensing width.
 *
 * `len` is the full extent of the cylindrical section because that is what the
 * eye measures — how long the tunnel is — while the formulae want the half, so
 * the halving happens once, here, rather than in every caller. (Spelled short
 * because `length` is a GLSL built-in and a parameter of that name would shadow
 * it for the body of the function.)
 */
struct MtWormhole {
    float rho;   // throat radius; the minimum of r
    float cyl;   // half the throat length: the cylinder is |l| <= cyl
    float mass;  // M in the profile above
};

MtWormhole mtWormhole(float rho, float len, float lens) {
    MtWormhole w;
    w.rho = max(rho, 1.0e-4);
    w.cyl = max(len, 0.0) * 0.5;
    w.mass = max(lens, 1.0e-4) / MT_LENS_W;
    return w;
}

/** The circumferential radius at proper distance `l` from the middle. */
float mtRadius(float l, MtWormhole w) {
    float al = abs(l);
    if (al <= w.cyl) return w.rho;
    float x = 2.0 * (al - w.cyl) / (PI * w.mass);
    return w.rho + w.mass * (x * atan(x) - 0.5 * log(1.0 + x * x));
}

/**
 * dr/dl. Analytic, not a difference — the geodesic equation multiplies it by
 * b^2/r^3, so an error here does not blur the picture, it bends the light by
 * the wrong amount and produces a perfectly plausible wrong one.
 */
float mtSlope(float l, MtWormhole w) {
    float al = abs(l);
    if (al <= w.cyl) return 0.0;
    float x = 2.0 * (al - w.cyl) / (PI * w.mass);
    return sign(l) * (2.0 / PI) * atan(x);
}

/**
 * The sine of the CRITICAL ANGLE seen from `l`: rays leaving the observer at a
 * smaller angle to the inward radial direction reach the far universe, rays at
 * a larger one turn around and come back.
 *
 * It is exactly `rho / r(l)`, and that one line is the whole geometry of the
 * shot. A ray's impact parameter is b = r(l) sin(alpha); it has a turning point
 * where r(l) = b; the smallest r anywhere is rho; so a ray with b < rho can
 * never turn. Three consequences worth having in closed form:
 *
 *   far away, alpha_c ~ rho / |l| — the far universe is a small disc;
 *   at the mouth, r = rho and alpha_c = 90 degrees — it fills the forward
 *     hemisphere and the sky is split exactly in half;
 *   ALL THE WAY THROUGH the cylinder r is still rho, so the split stays exactly
 *     at the horizon for the whole traverse. The tunnel does not open further.
 *     What happens there instead is that the sweep angle diverges at the
 *     horizon (tan alpha * length / rho, exactly), so both skies repeat in an
 *     accordion of rings — which is the reason to give the tunnel a length at
 *     all, and the reason the marcher needs a step budget.
 *
 * `test/metric.test.ts` bisects the numerically integrated crossed/returned
 * boundary and holds it to this value.
 */
float mtCritSin(float l, MtWormhole w) {
    return w.rho / mtRadius(l, w);
}

/**
 * The embedding profile: height of the surface above the flat plane, so that
 * (r(l), mtEmbedZ(l)) traced against the angle draws the funnel picture.
 *
 * Not used by the marcher. It is here because it is the statement that r is a
 * legal shape — the integrand is real exactly when |dr/dl| <= 1 — and because
 * anything that eventually decorates the throat wall wants the surface, not the
 * radius. Integrated with the trapezoid rule from the middle outward; the
 * cylinder contributes its own length exactly, since dz/dl is 1 there.
 */
float mtEmbedZ(float l, MtWormhole w, int steps) {
    float al = abs(l);
    if (al <= w.cyl) return l;
    float z = w.cyl;
    float h = (al - w.cyl) / float(max(steps, 1));
    float prev = 1.0;                       // dz/dl at the mouth: slope is 0 there
    for (int i = 1; i <= 64; ++i) {
        if (i > steps) break;
        float s = mtSlope(w.cyl + h * float(i), w);
        float cur = sqrt(max(1.0 - s * s, 0.0));
        z += 0.5 * (prev + cur) * h;
        prev = cur;
    }
    return sign(l) * z;
}

/**
 * The angle a transverse displacement subtends, integrated along l:
 * the integral of dl / r(l) from `a` to `b`.
 *
 * This is what a camera that is not flying straight down the axis needs. Its
 * angular position on the sphere obeys dchi/dt = vT / r(l) while dl/dt = vL, so
 * dividing gives dchi/dl = vT / (vL r) and the whole path collapses to this one
 * integral — no per-frame state, no simulation, and the camera stays a pure
 * function of time the way every other piece in this repo is.
 *
 * Trapezoid, because r is C1 but its SECOND derivative jumps at the mouth, and
 * a higher-order rule buys nothing across that kink. Inside the cylinder r is
 * exactly rho, so the rule is EXACT there rather than convergent — measured to
 * 2e-15, and `test/metric.test.ts` pins it, which is a much stronger statement
 * than any tolerance on the general case.
 *
 * Outside, the mouth is what sets the step count. Over a symmetric span from
 * l = 8 to -8, 32 steps and 64 agree to 8e-4; over the worst spans in the
 * probe's sweep — the asymmetric ones with an endpoint near the mouth — they
 * agree only to 1e-2, which is the number the test holds and is 0.1% of a
 * result of order 8. For a camera path that is an angle error around 2e-4 rad,
 * far below anything a frame can show.
 */
float mtDrift(float a, float b, MtWormhole w, int steps) {
    int n = clamp(steps, 1, 64);
    float h = (b - a) / float(n);
    float acc = 0.0;
    float prev = 1.0 / mtRadius(a, w);
    for (int i = 1; i <= 64; ++i) {
        if (i > n) break;
        float cur = 1.0 / mtRadius(a + h * float(i), w);
        acc += 0.5 * (prev + cur) * h;
        prev = cur;
    }
    return acc;
}
