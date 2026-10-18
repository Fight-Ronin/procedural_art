// 014 — Frazil · anisotropy pass
//
// The part of the phase-field update that is a property of ONE cell: the
// direction of grad phi, the interface energy eps in that direction, and the
// two products the cross terms differentiate.
//
//   r  eps eps' phi_x
//   g  eps eps' phi_y
//   b  eps^2
//
// It is its own pass because the update needs these at the eight neighbours
// as well as the centre. Computed inside the update, every cell evaluated the
// anisotropy nine times — once for itself and once on behalf of each
// neighbour — and that redundancy was most of the cost of a step. Here each
// cell evaluates it once and the update pass reads the results. The two passes
// run in lockstep (meta.json "lockstep": true): flux, update, flux, update —
// otherwise the update would take twelve steps against one flux.
//
// The gradient uses the no-flux wall exactly as the update does: a neighbour
// outside the grid reads as this cell.

#include "core/math.glsl"
#include "pde/stencil.glsl"
#include "pde/phasefield.glsl"

uniform sampler2D uIce;   // @buffer ice "phase field, previous step"

const float DX      = 0.03;
const float EPS_BAR = 0.01;
// Fixed, not a parameter: the prototype swept it. 0 lets the grid choose the
// symmetry (a square crystal), 0.012 and 0.024 look alike, and the stiffness
// limit 1/(j^2 - 1) = 0.0286 caps it from above. See pfStiffLimit.
const float DELTA   = 0.02;
const int   SYM     = 6;
// One arm straight up: theta0 = pi / 2, given as (cos, sin) of 6 theta0 = 3 pi.
const vec2  CS0     = vec2(-1.0, 0.0);

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    if (uInit == 1) {
        // Runs before the ice pass is seeded, so there is nothing to read yet.
        fragColor = vec4(0.0);
        return;
    }
    ivec2 res = textureSize(uIce, 0);
    ivec2 c = ivec2(fragCoord);
    float self = texelFetch(uIce, c, 0).r;
    float s[9];
    for (int e = 0; e < 9; ++e) {
        ivec2 q = c + ivec2(e % 3 - 1, e / 3 - 1);
        bool in_ = all(greaterThanEqual(q, ivec2(0))) && all(lessThan(q, res));
        s[e] = in_ ? texelFetch(uIce, q, 0).r : self;
    }
    vec2 g = pdeGrad9(s, DX);
    vec2 ep = pfEpsDir(g, EPS_BAR, DELTA, SYM, CS0);
    fragColor = vec4(ep.x * ep.y * g, ep.x * ep.x, 0.0);
}
