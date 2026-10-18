// 014 — Frazil · simulation pass
//
// Kobayashi's (1993) phase field: a seed of ice in undercooled water, growing
// as fast as the latent heat it releases can diffuse away. The tips run ahead
// into colder water and grow faster, the hollows between them fill with heat
// and stall — that is the Mullins-Sekerka instability, and it is the whole
// reason the crystal branches instead of growing as a disc.
//
// State, one texel per cell:
//   r  phi   0 water .. 1 ice
//   g  T     dimensionless temperature, melting point at T_eq
//   b  t_s   the step at which this cell first froze (phi crossed 1/2), -1 if
//            never. Written once and never revised: phi forgets — side branches
//            coarsen, a plate fills the gaps it grows over — and t_s is the only
//            channel that keeps the crystal's history. The image is drawn from it.
//   a  the number of steps completed, identical in every texel, so the image
//      pass knows "now".
//
// phi and T are updated together because they are coupled within a step: T is
// driven by this step's dphi. The anisotropy is precomputed per cell by the
// flux pass, which runs before this one at every substep (meta.json
// "lockstep"), and read here at the centre and the eight neighbours for the
// cross terms d/dy(eps eps' phi_x) - d/dx(eps eps' phi_y) and for
// div(eps^2 grad phi).
//
// NO-FLUX WALLS, NOT A TORUS. A neighbour outside the grid reads as the cell
// that asked for it — for phi and T here, and for the flux one derivative
// further out — so every link that crosses the wall carries zero and
// sum(T - K phi) is conserved to rounding. A torus would let the crystal grow
// into itself from the far side.
//
// FLOAT32 STATE. Step counts and t_s are integers stored as floats; half floats
// stop counting at 2048, about frame 170. The physics does not depend on that —
// the melting-point schedule reads the step from paSample, an int — but the
// afterglow does, and on a device with only RGBA16F targets it freezes there.
//
// Constants are Kobayashi's, at the scale of the common reproductions of the
// paper. delta and j live in the flux pass.

#include "core/math.glsl"
#include "core/const.glsl"
#include "hash/hash.glsl"
#include "pde/stencil.glsl"
#include "pde/phasefield.glsl"

uniform sampler2D uIce;   // @buffer ice  "previous state"
uniform sampler2D uFlux;  // @buffer flux "anisotropy, this step"

uniform float uK;         // @param 1.3 .. 2.5 = 1.8 "latent heat"
uniform float uTeqA;      // @param 0.9 .. 1.4 = 1.0 "early undercooling"
uniform float uTeqB;      // @param 0.9 .. 1.4 = 1.35 "late undercooling"
uniform float uSwitch;    // @param 0.0 .. 1.0 = 0.84 "switch (fraction of life)"
uniform float uLife;      // @param 1000.0 .. 12000.0 = 6700.0 step 100 "life (steps)"
uniform int   uEpochs;    // @param 0 .. 5 = 4 step 1 "seeded epochs"
uniform float uWobble;    // @param 0.0 .. 0.06 = 0.03 "weather"
uniform float uNoise;     // @param 0.0 .. 0.02 = 0.006 "nucleation noise"

const float DX      = 0.03;
const float DT      = 1.0e-4;
const float RELAX   = 3.0e-4;   // Kobayashi's tau; TAU is 2 pi in core/const
const float ALPHA   = 0.9;
const float GAMMA   = 10.0;
const float SEED_R  = 5.0;      // cells

/**
 * The melting point as a function of time: the history of the water the
 * crystal grows in. The crystal's radius is time, so this history is what the
 * picture is a record of.
 *
 * Two ways to write it:
 *
 *   uEpochs = 0  the hand schedule: uTeqA, then uTeqB from uSwitch on. Presets
 *                use this, so a named look is the same picture whatever the seed.
 *   uEpochs = n  n epochs drawn from the seed. This is what makes the seed a
 *                different crystal rather than different noise: before it, six
 *                seeds grew six copies of one crystal with different side-branch
 *                detail, because the seed reached only the noise and the wobble.
 *
 * Seeded epochs ALTERNATE between a dendritic band [0.93, 1.08] and a plate
 * band [1.20, 1.40] — the two regimes the prototype sweep separated — starting
 * from either, with seeded lengths. Alternation rather than free draws, because
 * two neighbouring epochs drawn close together leave no visible boundary, and an
 * epoch nobody can see is a seed that changes nothing.
 *
 * Boundaries are fractions of uLife, the steps the crystal takes to reach the
 * edge of the frame, so the same history fits a smaller grid by scaling one
 * number. On top of either, a slow wobble every tip feels at once: shared
 * history is why real crystals have six similar arms (Libbrecht 2005).
 */
float meltingPoint(float s) {
    float u = s / uLife;
    float t;
    if (uEpochs <= 0) {
        t = u < uSwitch ? uTeqA : uTeqB;
    } else {
        // Seeded lengths, normalised so the epochs fill the life.
        float w[5];
        float total = 0.0;
        for (int k = 0; k < 5; ++k) {
            w[k] = k < uEpochs ? 0.5 + hash21s(vec2(float(k), 17.0), uSeed) : 0.0;
            total += w[k];
        }
        bool plate = hash21s(vec2(3.0, 41.0), uSeed) < 0.5;
        float edge = 0.0;
        t = 1.0;
        for (int k = 0; k < 5; ++k) {
            if (k >= uEpochs) break;
            float h = hash21s(vec2(float(k), 59.0), uSeed);
            t = plate ? mix(1.20, 1.40, h) : mix(0.93, 1.08, h);
            edge += w[k] / total;
            if (u < edge) break;
            plate = !plate;
        }
    }
    vec3 ph = vec3(hash21s(vec2(1.7, 3.1), uSeed),
                   hash21s(vec2(5.3, 2.9), uSeed),
                   hash21s(vec2(7.1, 0.3), uSeed)) * TAU;
    vec3 wv = sin(s / vec3(150.0, 290.0, 530.0) + ph);
    return t + uWobble * (wv.x + wv.y + wv.z) * 0.8164966; // 1 / sqrt(3/2)
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    ivec2 res = textureSize(uIce, 0);
    ivec2 c = ivec2(fragCoord);

    if (uInit == 1) {
        vec2 d = vec2(c) - vec2(res) * 0.5;
        float phi = dot(d, d) < SEED_R * SEED_R ? 1.0 : 0.0;
        fragColor = vec4(phi, 0.0, phi >= 0.5 ? 0.0 : -1.0, 0.0);
        return;
    }

    // ---- reads: 3x3 of the state and of the flux, walls read as the centre ---
    vec4 self = texelFetch(uIce, c, 0);
    vec4 fluxC = texelFetch(uFlux, c, 0);
    float P[9], T9[9], AX[9], AY[9], E2[9];
    for (int e = 0; e < 9; ++e) {
        ivec2 q = c + ivec2(e % 3 - 1, e / 3 - 1);
        bool in_ = all(greaterThanEqual(q, ivec2(0))) && all(lessThan(q, res));
        vec4 st = in_ ? texelFetch(uIce, q, 0) : self;
        vec4 fx = in_ ? texelFetch(uFlux, q, 0) : fluxC;
        P[e] = st.r;  T9[e] = st.g;
        AX[e] = fx.r; AY[e] = fx.g; E2[e] = fx.b;
    }

    // ---- phase field -----------------------------------------------------------
    float t1 =  pdeGrad9(AX, DX).y;                                  //  d/dy(eps eps' phi_x)
    float t2 = -pdeGrad9(AY, DX).x;                                  // -d/dx(eps eps' phi_y)
    float t3 = E2[4] * pdeLap9(P, DX) + dot(pdeGrad9(E2, DX), pdeGrad9(P, DX)); // div(eps^2 grad phi)

    // Steps completed so far, from the integer sample ordinal rather than the
    // stored count, so the schedule stays exact whatever the target precision.
    float now = float(paSample);
    float phi = self.r;
    float t = self.g;
    float reac = pfReaction(phi, pfDrive(t, meltingPoint(now), ALPHA, GAMMA));
    // Nucleation noise lives only in the interface, where phi (1 - phi) > 0:
    // it is what starts side branches, and in bulk water or bulk ice it would
    // be heat from nowhere.
    reac += uNoise * phi * (1.0 - phi) * (paRand() - 0.5);

    float phiN = phi + DT / RELAX * (t1 + t2 + t3 + reac);

    // ---- heat ------------------------------------------------------------------
    // K (phiN - phi), not K dphi/dt from the right-hand side: the latent heat
    // released is exactly the ice that formed, noise included.
    float tN = t + DT * pdeLap9(T9, DX) + uK * (phiN - phi);

    float ts = self.b;
    if (ts < 0.0 && phiN >= 0.5) ts = now + 1.0;

    fragColor = vec4(phiN, tN, ts, now + 1.0);
}
