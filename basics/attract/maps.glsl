#pragma once
#include "core/math.glsl"

/**
 * Strange attractors of the plane: one iteration each.
 *
 * These are the classic density-plot maps. You do not evaluate them at a point
 * to get a value — you ITERATE them from many starts and plot where the orbits
 * spend their time, and the picture is the attractor's invariant measure. That
 * makes them the natural first citizens of a scatter pass: there is no function
 * of position that produces the image, only a great many points that land.
 *
 * ONE STEP EACH, NOT THE LOOP. The same reason `raymarch/march.glsl` declares
 * `sceneSdf` and `field/flow.glsl` keeps its integrator in the artwork: a
 * general iterator here would have to be handed which map to iterate, GLSL has
 * no function pointers, and the only way to express that is a second undefined
 * prototype in basics/ — which `test/layers.test.ts` exists to prevent. The
 * loop is four lines in the artwork and costs nothing to write there.
 *
 * EVERY MAP HERE IS BOUNDED, and the bound is stated as a function beside it.
 * A scatter pass has to size the region it deposits into, and an orbit that
 * escapes that region is not clipped in a way anyone notices — it simply stops
 * contributing, so the picture quietly loses its tails and looks like a
 * slightly different attractor. Knowing the bound analytically means the piece
 * can frame the whole thing instead of guessing and cropping.
 *
 * Parameters are the interesting part of these maps: most values give a smear
 * or a fixed point, and the small minority that give structure are found by
 * looking. `npm run sheet` is the tool for that.
 */

/**
 * Peter de Jong.
 *
 * Bounded by 2 in each component, exactly: each coordinate is a difference of a
 * sine and a cosine, so |x'| <= |sin| + |cos| <= 2 with no assumption on the
 * parameters at all.
 */
vec2 atrDeJong(vec2 p, vec4 k) {
    return vec2(sin(k.x * p.y) - cos(k.y * p.x),
                sin(k.z * p.x) - cos(k.w * p.y));
}

float atrDeJongBound(vec4 k) { return 2.0; }

/**
 * Clifford Pickover.
 *
 * Bounded by 1 + |c| in x and 1 + |d| in y, so unlike de Jong its extent
 * depends on the parameters — which is exactly why the bound is a function
 * rather than a constant, and why a piece that hardcoded 2 here would crop
 * every interesting parameter set differently.
 */
vec2 atrClifford(vec2 p, vec4 k) {
    return vec2(sin(k.x * p.y) + k.z * cos(k.x * p.x),
                sin(k.y * p.x) + k.w * cos(k.y * p.y));
}

vec2 atrCliffordBound(vec4 k) { return 1.0 + abs(k.zw); }

/**
 * Svensson.
 *
 * Bounded by |d| + 1 in x and |c| + 1 in y. Tends to produce tighter, more
 * lace-like structure than the other two at comparable parameters.
 */
vec2 atrSvensson(vec2 p, vec4 k) {
    return vec2(k.w * sin(k.x * p.x) - sin(k.y * p.y),
                k.z * cos(k.x * p.x) + cos(k.y * p.y));
}

vec2 atrSvenssonBound(vec4 k) { return vec2(abs(k.w) + 1.0, abs(k.z) + 1.0); }

/**
 * One step of the quadratic map that Sprott catalogued, given 12 coefficients.
 *
 * NOT BOUNDED, and that is the point of including it: most coefficient sets
 * diverge, a few are chaotic and bounded, and finding the second kind is the
 * whole game. A piece using this has to clamp or reject escaping orbits itself
 * — `atrEscaped` is the test — because there is no analytic bound to lean on.
 */
vec2 atrQuadratic(vec2 p, float a[12]) {
    float x = p.x;
    float y = p.y;
    return vec2(
        a[0] + a[1] * x + a[2] * x * x + a[3] * x * y + a[4] * y + a[5] * y * y,
        a[6] + a[7] * x + a[8] * x * x + a[9] * x * y + a[10] * y + a[11] * y * y);
}

/**
 * Has this orbit left the basin?
 *
 * A divergent orbit reaches infinity fast and then produces NaN, and NaN
 * deposited into a float target poisons every texel it touches — additively
 * blended, one bad point turns a whole texel into NaN for the rest of the
 * frame, and NaN survives every later average. So this checks for the escape
 * BEFORE the values get large enough to stop being comparable.
 */
bool atrEscaped(vec2 p, float radius) {
    return !(dot(p, p) < radius * radius);   // negated, so NaN counts as escaped
}
