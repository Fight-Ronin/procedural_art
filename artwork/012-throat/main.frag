// 012 — Throat
//
// A wormhole, seen by integrating the light rather than by drawing a shape.
//
// Every previous piece in this repo puts light on straight lines: a marcher
// walks `ro + rd * t`, and the picture is what the scene does to that line.
// Here the line is the unknown. The camera fires a direction, the direction
// becomes an impact parameter, and the ray is then the numerical solution of a
// geodesic equation in a Morris-Thorne metric — so the SUBJECT of the piece is
// the geometry itself, not an object lit inside one. That is the reason to make
// it: the weakest pieces here have been the ones that are a shape with the
// lighting doing all the work (005 and 006 both were, and a separate block has
// since rescued 006 by changing what is in frame and MEASURED that 005's
// problem is out of reach of its parameters). Here the space is the shape.
//
// WHAT YOU ARE LOOKING AT, in closed form. A ray leaving the camera at angle
// alpha to the inward radial direction has impact parameter b = r(l) sin(alpha)
// and turns around where r = b. The narrowest r anywhere is the throat radius
// rho, so:
//
//     sin(alpha_c) = rho / r(l)
//
// is an exact edge on the screen, with the far universe inside it and this one
// outside. Far away it is a small disc. At the mouth r = rho, so it is ninety
// degrees — the far sky fills the forward hemisphere and the two universes
// split the view exactly in half. THROUGH the whole cylindrical throat r is
// still rho, so that split does not move: the tunnel never opens further. What
// happens inside instead is that the sweep angle goes as tan(alpha), which
// diverges at the horizon, so both skies repeat outward in an accordion of
// rings. `uMode = 1` draws that analytic circle on top of the numerically
// classified pixels; they should sit on each other.
//
// THE CAMERA HAS A TRANSVERSE VELOCITY, and the first version did not. Flying
// straight down the axis gives no parallax at all — nothing in the frame
// translates, only bends — and with a radially symmetric projection the result
// is a bullseye. `uVT` carries the camera around the sphere as it falls, which
// is parallax, and tilts the beaming axis off the throat, which is what stops
// the bright forward spot being concentric with everything else.
//
// STEP COUNT IS A PARAMETER, NOT A QUALITY SETTING, and this is the one place
// the piece departs from the repo's usual "gate cost on uQuality". The step
// count changes the PATH, not the sampling noise, so two settings are two
// pictures rather than a rough one and a smooth one, and gating it would make
// the print differ from the preview in shape. It is also not monotone: measured
// in 32-bit float, the null residual bottoms out near h = 0.1 and gets worse
// below it as round-off overtakes truncation. See metric/geodesic.glsl.
//
// KNOWN, AND VISIBLE: rays near the critical angle wind many times before they
// leave — 35 turns at b/rho = 0.9999 — so a finite `uSteps` is exhausted in a
// thin ring at exactly alpha_c. That ring sits where the eye is already looking
// and looks like a physical feature. `uMode = 2` shows the budget so it can be
// told apart from one.

#include "core/const.glsl"
#include "core/math.glsl"
#include "hash/hash.glsl"
#include "color/blackbody.glsl"
#include "color/palette.glsl"
#include "noise/noise3.glsl"
#include "raymarch/camera.glsl"
#include "relativity/boost.glsl"
#include "metric/geodesic.glsl"

uniform float uRho;      // @param 0.3 .. 3.0 = 1.0 "throat radius"
uniform float uLen;      // @param 0.0 .. 8.0 = 3.0 "throat length"
uniform float uLens;     // @param 0.05 .. 3.0 = 0.60 "lensing width"

uniform float uPos;      // @param -14.0 .. 14.0 = 12.0 "camera l"
uniform float uBeta;     // @param -0.95 .. 0.95 = -0.35 "radial speed (c)"
uniform float uVT;       // @param -0.90 .. 0.90 = 0.20 "transverse speed (c)"
uniform float uFov;      // @param 0.4 .. 6.0 = 1.80 "field of view"
uniform float uTilt;     // @param -0.8 .. 0.8 = 0.45 "camera tilt"
uniform int   uProj;     // @enum 1:fisheye 0:pinhole "projection"

uniform float uStride;   // @param 0.04 .. 0.60 = 0.28 "step length"
uniform int   uSteps;    // @param 32 .. 512 = 192 step 8 "step budget"
uniform float uFar;      // @param 6.0 .. 40.0 = 14.0 "exit distance"

uniform float uSkyScale;  // @param 0.4 .. 8.0 = 3.20 "sky scale"
uniform int   uSkyOct;    // @param 1 .. 6 = 4 step 1 "sky octaves"
uniform float uSkyGain;   // @param 0.0 .. 2.0 = 0.035 "sky brightness"
uniform float uSkyFloor;  // @param 0.0 .. 0.9 = 0.78 "sky floor"

uniform float uStarScale; // @param 8.0 .. 160.0 = 40.0 "star density"
uniform float uStarFill;  // @param 0.002 .. 0.9 = 0.006 "star fill"
uniform float uStarSize;  // @param 200.0 .. 60000.0 = 9000.0 "star sharpness"
uniform float uStarGain;  // @param 0.0 .. 6.0 = 0.05 "star brightness"
uniform float uSkySeed;   // @param 0.0 .. 64.0 = 3.0 step 1 "sky seed"

uniform float uNearK;    // @param 800.0 .. 20000.0 = 13000.0 "near sky kelvin"
uniform float uFarK;     // @param 800.0 .. 14000.0 = 3000.0 "far sky kelvin"
uniform float uStarKHot; // @param 3000.0 .. 20000.0 = 11000.0 "hot star kelvin"
uniform float uStarKCold;// @param 1200.0 .. 6000.0 = 3200.0 "cool star kelvin"
uniform float uBeam;     // @param 0.0 .. 1.0 = 1.0 "beaming"

uniform float uDiskGain;  // @param 0.0 .. 8.0 = 2.50 "disk brightness"
uniform float uDiskIn;    // @param 0.8 .. 6.0 = 1.60 "disk inner radius"
uniform float uDiskOut;   // @param 2.0 .. 20.0 = 7.00 "disk outer radius"
uniform float uDiskK;     // @param 1200.0 .. 9000.0 = 4200.0 "disk kelvin at the inner edge"
uniform float uDiskScale; // @param 0.2 .. 6.0 = 1.20 "disk texture scale"
uniform int   uDiskOct;   // @param 1 .. 6 = 4 step 1 "disk octaves"
uniform float uDiskFloor; // @param 0.0 .. 0.9 = 0.45 "disk floor"
uniform float uDiskBeta;  // @param -0.95 .. 0.95 = 0.56 "orbital speed at the inner edge (c)"
uniform float uDiskTilt;  // @param 0.02 .. 1.2 = 0.22 "disk tilt (camera above plane)"

uniform float uFarGain;  // @param 0.0 .. 2.0 = 0.60 "far sky brightness, x sky"

uniform int   uPalette;  // @enum 1:violet 0:physical 2:teal 3:jade "palette"

uniform int   uMode;     // @enum 0:image 1:crossing 2:budget 3:radiance 4:magnification "mode"
uniform float uRingW;    // @param 0.001 .. 0.05 = 0.006 "analytic ring width"
uniform float uFilter;   // @param 0.0 .. 3.0 = 0.0 "footprint filter"
uniform float uMagMax;   // @param 1.0 .. 400.0 = 80.0 "magnification cap"
uniform float uProbe;    // @param 0.05 .. 4.0 = 0.60 "radiance probe level"

const int TH_MAX_STEPS = 512;
/** Trapezoid steps for the camera's transverse drift. 32 reach four digits. */
const int TH_DRIFT_STEPS = 48;

/** One marched ray. */
struct ThRay {
    float psi;      // total sweep, including the analytic tail
    vec3 disk;      // light picked up crossing the disk, in linear radiance
    bool crossed;   // ended in the far universe
    bool spent;     // ran out of step budget before it got away
    int used;
};

/**
 * Temperature to colour, with the physics kept and the hue handed back.
 *
 * `colBlackbody` is the honest answer and it has one hard limitation that no
 * amount of parameter tuning gets around: a Planck curve at any temperature
 * lies on the Planckian locus, so the ONLY hues available are deep red, orange,
 * yellow, white and blue. Between 1500 K and 4500 K — which is where a thin
 * disk's radiance actually is — that means yellow, and a picture whose entire
 * warm half is one narrow band of yellow-orange reads as sickly rather than
 * hot. There is no teal on that curve, no magenta, no violet.
 *
 * So: keep the ORDERING physical and make the HUE a choice. Temperature maps to
 * a normalised coordinate that is monotone in T — which the blackbody's own
 * blue-over-red ratio already is, and `test/relativity.test.ts` pins that
 * monotonicity — and the coordinate then indexes a ramp. Every relativistic
 * shift still moves the colour the same distance in the same direction; what
 * changes is where that direction points in colour space. Astronomers call this
 * false colour and it is not a cheat, it is a stated re-mapping.
 *
 * EVERY RAMP IS NORMALISED TO UNIT LUMINANCE, exactly like `colBlackbody`. That
 * is not decoration: the disk's brightness is written out explicitly as r^-3
 * and the beaming factor is applied on top, so a tint that carried brightness of
 * its own would quietly multiply into both and put the whole T^4-versus-D^4
 * separation back in play.
 */
float thTempCoord(float kelvin) {
    // Spanning 1000..6000 K rather than the whole Planckian range, because this
    // coordinate exists for ONE consumer: the disk, whose temperature runs from
    // about 1250 K at the rim to uDiskK at the inner edge. Normalised over the
    // full 700..24000 K the disk only ever reached the lower third of the ramp
    // and every palette came out as one flat hue with its bright end unused.
    return sat(log(max(kelvin, 300.0) / 1000.0) / log(6000.0 / 1000.0));
}

vec3 thTint(float kelvin) {
    vec3 c;
    if (uPalette == 0) {
        c = colBlackbody(kelvin);
    } else if (uPalette == 1) {
        // violet -> rose -> pale gold. Warm without being yellow, because the
        // warm end arrives through magenta rather than through orange.
        c = colRamp3(thTempCoord(kelvin), vec3(0.045, 0.020, 0.150),
                     vec3(0.520, 0.085, 0.330), vec3(1.000, 0.870, 0.760));
    } else if (uPalette == 2) {
        // teal -> cyan -> white. One cool hue all the way up, so the only warm
        // thing left in the frame is whatever is hot enough to be white.
        c = colRamp3(thTempCoord(kelvin), vec3(0.010, 0.070, 0.090),
                     vec3(0.080, 0.430, 0.520), vec3(0.880, 0.990, 1.000));
    } else {
        // jade -> rose -> cream: the two ends are near-complementary, which is
        // the widest colour interval available without either end going neon.
        c = colRamp3(thTempCoord(kelvin), vec3(0.020, 0.110, 0.075),
                     vec3(0.620, 0.190, 0.230), vec3(1.000, 0.940, 0.850));
    }
    return c / max(colLumaLinear(c), 1.0e-6);
}

/**
 * The light a ray picks up where it cuts the disk plane.
 *
 * SOMETHING HAS TO BE IN THE SPACE. Every wormhole and black hole picture that
 * reads as a scene rather than a texture has a bright structured object in it
 * for the geometry to bend — an accretion disk — and the first eleven versions
 * of this piece had only a background sky. Lensing a background produces a
 * smear; lensing an OBJECT produces the doubled arcs that say what the geometry
 * is doing, because you can see the far side of the disk over the top of the
 * throat and under the bottom of it at the same time.
 *
 * Thin-disk temperature goes as r^-3/4, so the radiance that goes with it goes
 * as r^-3. That steep falloff is the point: it puts a small white-hot ring
 * inside a long cool skirt, which is exactly the value structure the picture
 * was missing — most of the frame dark, a little of it very bright.
 *
 * IT IS ALSO THE PIECE'S ONLY LIGHT SOURCE, and the gain that follows from that
 * is measured rather than chosen. `test/render.test.ts` holds every piece
 * declaring bloom to a visible halo, on the finding that bloom needs radiance
 * above 1 from something IN THE FRAME — and once the stars were thinned out to
 * fix the muddy centre, nothing else in this picture clears the threshold. At
 * 120px the bloom delta runs 0.76, 1.40, 2.34, 3.21 for gains of 2, 3, 4.5, 6
 * while the frame's MEAN level moves only 31.4 -> 34.0, because every extra
 * photon lands in the thin inner annulus and nowhere else. The default is 4:
 * the inner edge glows, and the rest of the picture is not lifted at all.
 *
 * THAT T^4 IS NOT THE D^4 NEXT DOOR. The Stefan-Boltzmann scaling here is the
 * disk's own physics, varying across its radius; the beaming factor applied to
 * the result is the observer's boost. Both are real and both apply. (The trap
 * that block 21 fell into was different: using a blackbody's own T^4 AND the
 * beaming factor for the same shift. `colBlackbody` still carries no
 * brightness, and the brightness here is written out explicitly.)
 *
 * THE MATERIAL IS MOVING, AND THAT IS A SECOND BOOST. The camera's own is
 * applied to the whole frame in `mainImage`; this one belongs to the orbiting
 * gas and is applied per crossing, because it points a different way on each
 * side of the disk. It is the single largest visual fact about a real accretion
 * disk — one side bright and blue, the other nearly gone — and at beta = 0.56
 * near the inner edge the two sides differ by a factor of seventy in radiance.
 *
 * THE TWO BOOSTS MULTIPLY EXACTLY, and the reason is worth stating because it
 * is a property of THIS metric rather than a convenient approximation. Photon
 * energy measured by static observers is conserved along the ray, since d/dt is
 * a Killing vector and g_tt is identically -1 here. So there is no
 * gravitational redshift anywhere in this spacetime — every colour change in
 * the frame is kinematic, and the total factor is the product of the emitter's
 * and the camera's. A Schwarzschild version of this piece would need a third
 * term; this one does not, and that is why a wormhole is the tractable subject.
 *
 * THE VELOCITY FIELD IS ONE FIELD WITH TWO CONSUMERS, and it is derived rather
 * than declared twice. `uDiskBeta` is the orbital speed at the inner edge; the
 * profile is Keplerian, v = beta sqrt(r_in / r), and the shear angle below is
 * that same v divided by r and integrated over time. So the streaks you watch
 * move are moving at exactly the speed the colour claims, which is a constraint
 * the picture would otherwise have no way to keep.
 *
 * AND THE DIRECTION IS TAKEN FROM `rot3` RATHER THAN FROM A CROSS PRODUCT.
 * `cross(axis, p)` asserts a handedness; `rot3`'s is the opposite of the one
 * most people write down (it builds its matrix in row order, which GLSL reads
 * as columns, so it rotates by -a). Differencing the actual rotation the shear
 * uses means the two cannot disagree whatever `rot3` does — and a sign error
 * here would not look like a bug, it would look like a disk spinning the other
 * way with the wrong side lit, which is the exact shape of the two axis
 * mistakes this piece has already made.
 */
vec3 thDiskEmit(vec3 n, float rr, vec3 axis, vec3 dHat, float dopCam) {
    // Keplerian shear: the inner material laps the outer, which is what makes a
    // static noise field read as something in orbit rather than a stencil.
    // Omega = v / r with v = uDiskBeta sqrt(r_in / r) collapses to this.
    float x = uDiskIn / max(rr, 1.0e-3);
    float ang = uDiskBeta * uTime * pow(x, 1.5) / max(uDiskIn, 1.0e-3);
    vec3 q = (rot3(axis, ang) * n) * rr;
    float tex = sat((nzFbm31(q * uDiskScale, uDiskOct) * 0.5 + 0.5 - uDiskFloor)
                    / max(1.0 - uDiskFloor, 1.0e-3));

    // The same field, as a velocity. The material advances OPPOSITE to the way
    // the query point is rotated — sampling at R(a) p shows the feature that
    // has travelled from R(a) p to p — so the tangent is p - R p and not the
    // other way round. Clamped below c because `uDiskBeta` multiplies a profile
    // that can exceed 1 inside the inner radius; the disk never lives there,
    // and the clamp is a guard rather than a shape.
    float speed = clamp(uDiskBeta * sqrt(x), -0.95, 0.95);
    vec3 vHat = normalize(n - rot3(axis, 0.01) * n);

    // `dHat` is the ray's direction at the crossing, in the static frame,
    // pointing AWAY from the camera — which is exactly the static-frame viewing
    // direction of an observer sitting in the gas and looking back along the
    // sight line. `relDopplerStatic` in that slot gives E_gas / E_static, and
    // the factor wanted here is its reciprocal.
    float dMat = 1.0 / max(relDopplerStatic(dHat, vHat, speed), 1.0e-4);

    // Hard inside, soft outside. The inner edge is where the light is, and the
    // references are unanimous that the one edge worth keeping sharp is that
    // one; the outer rim should have nowhere you can point at and call an edge.
    float edge = smoothstep(uDiskOut, uDiskOut * 0.72, rr);

    // COLOUR TAKES BOTH FACTORS, BRIGHTNESS ONLY THIS ONE. `mainImage` already
    // multiplies everything down this ray by the camera's relBeam, so applying
    // it again here would square it; the temperature has no such shared step,
    // so the product of the two shifts has to be assembled at this point.
    float boost = mix(1.0, relBeam(dMat), uBeam);
    return thTint(uDiskK * pow(x, 0.75) * dMat * dopCam)
           * (uDiskGain * pow(x, 3.0) * tex * edge * boost);
}

/**
 * March one null geodesic out of the camera.
 *
 * `pl` is signed rather than derived from `sinTheta`: in a 172-degree fisheye a
 * good part of the frame looks BACKWARDS, away from the throat, and forcing the
 * ray inward would quietly render the wrong half of the sky.
 */
ThRay thTrace(float l0, float pl, float sinTheta, float far, MtWormhole w,
              vec3 n0, vec3 tHat, vec3 axis, bool wantDisk, float dopCam) {
    float b = mtGeoImpact(l0, sinTheta, w);
    vec3 y = vec3(l0, 0.0, pl);
    ThRay r;
    r.used = 0;
    r.disk = vec3(0.0);
    float hPrev = dot(n0, axis);          // psi is 0 at the camera
    for (int i = 0; i < TH_MAX_STEPS; ++i) {
        if (i >= uSteps || abs(y.x) > far) break;
        vec3 yPrev = y;
        mtGeoStep(y, uStride, b, w);
        r.used = i + 1;

        if (wantDisk) {
            vec3 nNow = cos(y.y) * n0 + sin(y.y) * tHat;
            float hNow = dot(nNow, axis);
            // A sign change is a crossing. INTERPOLATED to the crossing rather
            // than taken at the end of the step: a step is up to 0.28 of proper
            // length, which would smear the inner edge by 5% of the disk's
            // radius and soften the one edge worth keeping hard.
            if (hPrev * hNow < 0.0) {
                float t = hPrev / (hPrev - hNow);
                float lc = mix(yPrev.x, y.x, t);
                if (lc > 0.0) {                 // the disk lives in this universe
                    float rr = mtRadius(lc, w);
                    if (rr > uDiskIn && rr < uDiskOut) {
                        float pc = mix(yPrev.y, y.y, t);
                        vec3 pHat = normalize(cos(pc) * n0 + sin(pc) * tHat);
                        // The ray's own direction where it cuts the plane, in
                        // the static frame. dl/dxi is p_l along the radial and
                        // r dpsi/dxi = b/r across it, and the null condition
                        // makes the pair a unit vector with no normalise. This
                        // is what the orbital Doppler is measured against, so
                        // it is interpolated to the crossing like everything
                        // else here rather than taken at the end of the step.
                        vec3 psiHat = -sin(pc) * n0 + cos(pc) * tHat;
                        float plc = mix(yPrev.z, y.z, t);
                        vec3 dHat = plc * pHat + (b / rr) * psiHat;
                        r.disk += thDiskEmit(pHat, rr, axis, dHat, dopCam);
                    }
                }
            }
            hPrev = hNow;
        }
    }
    r.spent = abs(y.x) <= far;
    r.crossed = y.x < 0.0;
    r.psi = y.y + mtGeoTail(y, b, w);
    return r;
}

/**
 * Stars on a lattice in DIRECTION space.
 *
 * The sky has to be keyed by the ray's exit direction, never by screen
 * position — the whole point of the piece is that the map from screen to
 * direction is violently non-linear, and a backdrop drawn in screen space would
 * show none of it. Same reason env/sky.glsl is direction-keyed.
 *
 * A cell of the lattice at radius `scale` subtends about 1/scale radians, so
 * the twenty-seven neighbours are searched rather than the one containing cell:
 * a star whose jittered position falls near a face would otherwise be clipped
 * in half along a straight seam across the sky. It costs twenty-seven hashes
 * ONCE per ray, at the end of a march that already cost hundreds of steps.
 */
vec3 thStars(vec3 d, float scale, float fill, float sharp, float seed, float sigma, vec3 cool, vec3 warm) {
    // WIDENED TO THE PIXEL'S FOOTPRINT, AND FLUX IS CONSERVED WHILE IT WIDENS.
    // The intrinsic profile exp(-theta^2 * sharp) is a Gaussian of variance
    // 1/(2 sharp); convolving it with a pixel of angular radius `sigma` adds the
    // variances, and a 2D Gaussian of fixed total flux has a peak proportional
    // to 1/variance. So a star smaller than the pixel comes back dimmer and
    // broader by exactly the factor that keeps the light it carries constant.
    //
    // This is the fix for the thing block 1 measured and could not solve: a
    // point source through a bounded display transform is not resolution
    // stable, because at low resolution its peak is clipped differently than at
    // high.
    //
    // BUT WIDENING STOPS WORKING AT ONE LATTICE CELL, and that is the trap this
    // function fell into first. The sum below visits twenty-seven cells, which
    // is only enough while a star's profile is narrower than a cell; the filter
    // makes it wider, the tail falls outside the search, and the flux the
    // convolution was carefully conserving is quietly truncated — MORE at low
    // resolution, where sigma is larger, so the very bias being fixed comes
    // back with the opposite sign. Measured: the overall level went 1.71 -> 2.73
    // with the filter in, worse than none at all.
    //
    // Past a cell the right filter is not a wider point, it is the FIELD'S MEAN.
    // A pixel that covers many cells sees their average surface brightness, and
    // for a Poisson field of Gaussians that average is closed form: the density
    // `fill` per cell, times each star's flux pi/sharp, over the cell's solid
    // angle 1/scale^2. So the field fades from resolved stars into the uniform
    // glow it actually is, which is mean-preserving by construction and costs
    // nothing.
    vec3 meanTint = mix(cool, warm, 0.5);
    float meanSB = fill * PI * scale * scale / max(sharp, 1.0);
    float cell = 1.0 / scale;
    float blend = sat(sigma / cell - 1.0);
    if (blend >= 1.0) return meanTint * meanSB;

    float sig = min(sigma, 0.5 * cell);
    vec3 g = floor(d * scale);
    vec3 v = vec3(0.0);
    for (int i = 0; i < 27; ++i) {
        vec3 c = g + vec3(float(i % 3), float((i / 3) % 3), float(i / 9)) - 1.0;
        vec3 h = hash33(c + vec3(seed * 7.13, seed * 3.31, seed * 11.7));
        if (h.z > fill) continue;
        vec3 s = c + h;
        float ls = length(s);
        // Cannot degenerate in practice — |c| is about `scale` — but a zero
        // vector here would spray NaN over the frame, so it is designed out
        // rather than hoped away.
        if (ls < 1.0e-4) continue;
        float ca = dot(d, s / ls);
        if (ca <= 0.0) continue;

        // BRIGHTNESS IS EXPONENTIALLY DISTRIBUTED, not uniform. -log(1-U) gives
        // a great many faint stars and a few that are genuinely bright, which is
        // what a sky looks like; the uniform 0.35 + 1.3U it replaces gave every
        // star roughly the same weight and the field read as speckle rather than
        // as stars. Mean 1, so the closed-form surface brightness above is
        // unchanged.
        // CAPPED. -log(1-U) has no upper bound, and the tail is not a nice
        // long tail: at h.x = 0.9999 it is 9, and once a star is small enough
        // to be sub-pixel that peak lands on whichever sample happens to hit
        // it and the bloom pass smears the outlier into a halo the size of a
        // quarter of the frame. Measured, at uStarSize 45000: half the frame
        // white. Six is well past the brightest star anyone will notice and
        // leaves the distribution's shape intact everywhere below it.
        float mag = min(-log(max(1.0 - h.x, 1.0e-4)), 6.0);
        // Size varies too, and independently — a sky where every point is the
        // same size is the other half of why the old one read as noise.
        float sh = sharp * mix(0.35, 3.0, h.y * h.y);
        float var = 1.0 / (2.0 * sh) + sig * sig;
        float sharpEff = 1.0 / (2.0 * var);
        float amp = sharpEff / sh;

        // Colour, from the same hash. Real starfields are two-toned before they
        // are anything else, and two blackbodies mixed per star costs one lerp
        // where evaluating a Planck integral per star would cost a hundred.
        vec3 tint = mix(cool, warm, h.z / max(fill, 1.0e-3));

        // Angular profile in sin^2 rather than pow(cos, k): exp is stable and
        // the width is a plain angle, so `sharp` means the same thing at every
        // density.
        v += tint * (amp * exp(-(1.0 - ca * ca) * sharpEff) * mag);
    }
    return mix(v, meanTint * meanSB, blend);
}

/**
 * One universe's sky, in linear radiance, as seen with Doppler factor `d`.
 *
 * THE COLOUR IS A TEMPERATURE, and that is what makes the shift exact rather
 * than stylised. A Doppler factor scales a spectrum, and an RGB triple has no
 * spectrum to scale — but a Planck curve scaled in frequency by d is exactly a
 * Planck curve at d times the temperature. So the whole relativistic colour
 * shift is one multiply on a knob that was going to exist anyway, and the two
 * universes stop being two hex codes and become two temperatures.
 *
 * `colBlackbody` carries NO brightness (it is normalised to unit luminance), so
 * the T^4 that a real blackbody would bring is not applied twice — `relBeam`
 * upstream is that factor, and this is only the hue.
 *
 * THE BRIGHT PART IS THE EXTENDED PART. A point source seen through a bounded
 * display transform cannot be resolution-stable — see the note in
 * `test/render.test.ts` — so the nebular field carries the light and the stars
 * are dim punctuation. That constraint improved the picture as well as the
 * number: a star field is high frequency to begin with, so bending it just
 * makes more high frequency and reads as noise, while a SMOOTH field folded by
 * the map generates the fine structure itself. The accordion of rings near the
 * critical angle is the same nebula seen a dozen times, which is a statement
 * about the geometry rather than about the sky. The first version had it
 * backwards — fat bright stars, and at their density the frame saturated to
 * white with the ring structure buried inside it.
 */
vec3 thSky(vec3 dir, float kelvin, float gain, float d, float seed, float sigma) {
    vec3 q = dir * uSkyScale + vec3(seed * 4.7, seed * 2.3, seed * 6.1);

    // THE FIELD IS NOT BAND-LIMITED BY THE FOOTPRINT, AND THAT IS A DECISION —
    // but not the one the first version claimed. Dropping octaves finer than a
    // pixel is the textbook mip-map, and it is suspect for RIDGED noise, whose
    // octaves are rectified and so carry a mean as well as a variance: removing
    // one takes its mean away too and the low-resolution render comes out
    // darker. That reasoning is sound and it was NOT what was wrong here —
    // taking the band limit out moved the overall level 2.52 -> 2.73, slightly
    // the wrong way. It is gone because it costs a second noise evaluation to
    // buy nothing measurable, not because it was the bug.
    //
    // (Written down because a plausible explanation that the measurement then
    // refused is worth exactly as much as no explanation, and worse if it is
    // left in a comment looking settled.)
    //
    // Ridged rather than plain fbm: the fold has a floor, so subtracting one
    // before shaping is what makes filaments stand up instead of dimming the
    // whole field uniformly — 008's lesson about nzRidged31.
    float raw = nzRidged31(q, uSkyOct, 2.0, 0.5);
    float f = sat((raw - uSkyFloor) / max(1.0 - uSkyFloor, 1.0e-3));

    float shift = mix(1.0, d, uBeam);
    vec3 body = colBlackbody(kelvin * shift);
    // Two star populations rather than one temperature: the hot blue-white ones
    // and the cool orange ones, which is the contrast a real field has and the
    // cheapest way to stop the sky being one colour.
    vec3 cool = colBlackbody(uStarKHot * shift);
    vec3 warm = colBlackbody(uStarKCold * shift);

    vec3 s = thStars(dir, uStarScale, uStarFill, uStarSize, seed, sigma, cool, warm);
    // The gain scales the WHOLE universe, stars included. Applying it to the
    // nebula alone left the far side's stars at full brightness, and since the
    // throat is where they pile up, turning the far sky down did nothing at all
    // to the speckled blob in the middle — the thing it was added to fix.
    return (body * (uSkyGain * f * f) + s * uStarGain) * gain;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = artCoord(fragCoord);
    MtWormhole w = mtWormhole(uRho, uLen, uLens);

    // uBeta IS the speed, with no conversion, and that is a property of the
    // coordinates rather than a convenience: the metric has -dt^2 + dl^2, so
    // dl/dt measured by a static observer is already a velocity in units of c.
    // The camera's position knob and its speed knob are the same quantity
    // integrated once.
    float l0 = uPos + uTime * uBeta;
    float far = max(uFar, abs(l0) + 1.0);

    // THE CAMERA'S ANGULAR POSITION, and why it is not always the same one. A
    // purely radial flight has no parallax — nothing in the frame translates —
    // and with a radially symmetric projection that leaves the composition a
    // bullseye. A transverse velocity fixes both problems at once: it carries
    // the camera around the sphere, which IS parallax, and it tilts the beaming
    // axis away from the throat, so the bright forward spot stops being
    // concentric with the wormhole.
    //
    // It needs no state. dchi/dt = vT/r and dl/dt = vL divide into
    // dchi/dl = vT/(vL r), so the entire path is one integral over l and the
    // camera stays a pure function of (seed, frame) like everything else here.
    float chi = abs(uBeta) > 1.0e-4
        ? (uVT / uBeta) * mtDrift(uPos, l0, w, TH_DRIFT_STEPS)
        : uVT * uTime / mtRadius(l0, w);
    vec3 n0 = vec3(sin(chi), 0.0, cos(chi));   // where the camera is on the sphere
    vec3 ea = vec3(cos(chi), 0.0, -sin(chi));  // tangent, increasing chi
    vec3 eb = vec3(0.0, 1.0, 0.0);             // the other tangent

    // The camera basis is NOT a 3D camera. There is no world to point one at:
    // a point of this spacetime is (l, a direction on a sphere), which is four
    // numbers, and `rmCamera` builds a ray in three. So the projection gives a
    // direction in the camera's own basis (right, up, forward) = (eb, ea, -e_l)
    // and it is decomposed directly into the two things the geodesic wants.
    // The disk's axis, and `uDiskTilt` is the angle the camera sits ABOVE the
    // disk plane — which is what it has to be, and was not on the first try.
    // Mixing `eb` with `ea` looks like a tilt and is not one: both are
    // perpendicular to the camera's own position, so any combination of them
    // leaves the camera exactly IN the plane. A razor-thin disk seen exactly
    // edge on is a line of zero thickness, and the first render came back with
    // no disk at all — correctly. The axis has to lean toward `n0`.
    //
    // Zero is therefore the degenerate value, not the neutral one. A small
    // angle is the view worth having: the far side of the disk arrives over the
    // top of the throat and under the bottom of it at the same time, which is
    // the whole reason to put an object in the space.
    //
    // Built on `ea` and not `eb` because `eb` is the camera's RIGHT: an axis
    // along it stands the disk on its edge and the first version rendered a
    // band of vertical stripes. `ea` is the camera's up, which lays the disk
    // flat across the frame the way every reference image has it.
    vec3 axis = normalize(cos(uDiskTilt) * ea + sin(uDiskTilt) * n0);

    vec3 dir = uProj == 1 ? rmDirFisheye(uv, uFov) : rmDirPinhole(uv, uFov);
    dir.yz = rot2(uTilt) * dir.yz;

    // ABERRATION, HERE AND NOT LATER. At this point the frame is the camera's
    // own, which is the only frame the boost is valid in — a curved spacetime is
    // locally flat, so special relativity applies at the point and nowhere else.
    // Everything downstream sees an ordinary static-frame ray and knows nothing
    // about speed.
    //
    // The velocity has both components in that basis: radial uBeta along
    // e_l = (0,0,-1) and transverse uVT along ea = (0,1,0). The Doppler factor
    // is taken from the direction BEFORE aberrating, which is the camera-frame
    // one `relDoppler` expects.
    vec3 vel = vec3(0.0, uVT, -uBeta);
    float beta = min(length(vel), 0.95);
    vec3 uHat = beta > 1.0e-6 ? vel / max(length(vel), 1.0e-6) : vec3(0.0, 0.0, 1.0);
    float dop = relDoppler(dir, uHat, beta);
    dir = relAberrate(dir, uHat, beta);

    float pl = -dir.z;                   // radial component, along e_l
    vec2 tang = dir.xy;                  // components on (eb, ea)
    float sinA = length(tang);
    // The exact centre pixel is purely radial: b = 0, the sweep never leaves
    // zero, and the tangent is arbitrary. Picking one keeps normalize() away
    // from a zero vector instead of clamping the NaN afterwards.
    vec2 tn = sinA > 1.0e-6 ? tang / sinA : vec2(1.0, 0.0);

    vec3 tHat3 = tn.x * eb + tn.y * ea;
    ThRay r0 = thTrace(l0, pl, sinA, far, w, n0, tHat3, axis, uDiskGain > 0.0 && uMode == 0, dop);

    // THE SECOND RAY, and what it buys. The map from a viewing direction to a
    // sky direction is (theta, phi) -> (Psi(theta), phi), so its area Jacobian
    // is (sin Psi / sin theta) |dPsi/dtheta| — the classical lensing
    // magnification — and one finite difference in theta is the whole of it.
    // `theta` is measured from the INWARD radial, which is what makes the same
    // expression cover the rays that look backwards.
    //
    // It doubles the cost of the piece and it is what makes the sky honest: a
    // pixel near the axis or near the critical angle covers hundreds of times
    // more sky than one out at the rim, and until now every one of them sampled
    // the sky as if it were a point.
    // GATED, because the default does not use it. The branch is on uniforms, so
    // it is coherent across the whole draw and the second march really is not
    // paid for — which matters, since it is a doubling of the most expensive
    // piece in the repo.
    bool wantMag = uFilter > 0.0 || uMode == 4;
    float theta = atan(sinA, -pl);
    float de = 1.0e-3;
    // Spelled as a statement rather than a ternary: GLSL ES has no conditional
    // operator for structs.
    ThRay r1 = r0;
    float dPsi = 0.0;
    if (wantMag) {
        // The companion ray never gathers disk light: it exists to measure a
        // derivative, and paying for the disk twice would be the whole point of
        // gating the second march away again.
        r1 = thTrace(l0, -cos(theta + de), sin(theta + de), far, w, n0, tHat3, axis, false, dop);
        dPsi = (r1.psi - r0.psi) / de;
    }
    // Capped, not because the number is wrong but because it is unbounded: on
    // the axis and at the critical angle it genuinely diverges, and a filter
    // width has to stay finite. Rays whose neighbour landed in the OTHER
    // universe straddle a discontinuity, where the difference quotient means
    // nothing; those take the cap too.
    float mag = !wantMag ? 1.0
        : (r1.crossed == r0.crossed ? min(mtLensMag(sinA, r0.psi, dPsi), uMagMax)
                                    : uMagMax);

    // The pixel's angular footprint in the camera frame, then pushed through
    // both maps: the boost scales solid angle by D^2 (measured, not assumed —
    // see test/relativity.test.ts) and the lens by `mag`, so the LINEAR width
    // picks up D and the square root of the magnification.
    float pixAng = uProj == 1 ? pxSize() * uFov : pxSize() * 2.0 * tan(uFov * 0.5);
    float sigma = pixAng * dop * sqrt(mag) * uFilter;

    bool spent = r0.spent;
    bool crossed = r0.crossed;
    int used = r0.used;
    // Back to three dimensions: the ray landed at angle Psi from the camera's
    // own position on the sphere, in the plane that position spans with the
    // tangent of the ray's sideways component.
    vec3 skyDir = cos(r0.psi) * n0 + sin(r0.psi) * (tn.x * eb + tn.y * ea);

    vec3 L;
    if (uMode == 1) {
        // The numerically classified pixels, with the ANALYTIC edge drawn over
        // them. sin(alpha_c) = rho / r(l0) is a screen-space circle, and the
        // width is stated in units of sin(alpha) — a domain quantity — so the
        // overlay is the same thickness at every output size.
        float edge = abs(sinA - mtCritSin(l0, w));
        float ring = 1.0 - smoothstep(uRingW * 0.5, uRingW, edge);
        L = crossed ? vec3(0.12, 0.30, 0.16) : vec3(0.05, 0.07, 0.16);
        if (spent) L = vec3(0.35, 0.10, 0.02);
        L = mix(L, vec3(1.0, 0.95, 0.35), ring);
    } else if (uMode == 2) {
        float f = float(used) / float(max(uSteps, 1));
        L = spent ? vec3(1.0, 0.15, 0.05) : vec3(f * f);
    } else if (uMode == 4) {
        // The magnification, log-banded. Bright where one pixel is covering a
        // great deal of sky: the axis, and the ring at the critical angle.
        float t = sat(log2(max(mag, 1.0)) / log2(max(uMagMax, 2.0)));
        L = vec3(t * t, t, sqrt(t)) * 0.9;
    } else {
        // The beaming factor is D to the FOURTH — energy, arrival rate, and
        // solid angle twice over. `relBeam` is where that is argued, and
        // `test/relativity.test.ts` measures the solid angle half of it off the
        // aberration map rather than taking it on trust.
        //
        // This is what finally puts real radiance above 1 in this piece: at
        // beta 0.55 the sky dead ahead arrives nine times brighter, on an
        // EXTENDED field, which is both what the float accumulator is for and
        // the first thing here worth a bloom pass.
        float gain = mix(1.0, relBeam(dop), uBeam);
        // THE FAR SKY GETS ITS OWN GAIN, and turning it down is what makes the
        // throat a hole rather than a smudge. Seen through the mouth it is the
        // darkest region of the frame and it was being filled with the same
        // ridged noise as everything else, which at low brightness reads as
        // neither a void nor a window — just mud in the one place the eye goes.
        // A silhouette needs somewhere genuinely empty to be a silhouette
        // against.
        vec3 sky = crossed ? thSky(skyDir, uFarK, uFarGain, dop, uSkySeed + 17.0, sigma)
                           : thSky(skyDir, uNearK, 1.0, dop, uSkySeed, sigma);
        // The disk's light reaches the camera down the same ray, so it takes
        // the same boost. It is added rather than composited: the disk is thin
        // and optically thin, and a ray that cuts it twice should be twice as
        // bright — which is exactly what makes the doubled arcs read.
        L = gain * (sky + r0.disk);
    }

    // uMode 3: WHERE THE LIGHT ACTUALLY IS, in linear radiance, before the
    // display transform touches it. 008 had to build this by hand to find out
    // that its bloom threshold was reading a perceptual quantity; it is cheap
    // enough to keep, and it is the only way to answer "is this piece hot
    // enough for a halo" without arguing about a tonemapped picture.
    //
    //   grey   below the bloom threshold        blue  threshold .. 1
    //   green  1 .. 4                           red   above 4
    if (uMode == 3) {
        float lum = colLumaLinear(L);
        vec3 band = vec3(lum * 0.5);
        if (lum > uProbe) band = vec3(0.05, 0.25, 0.9);
        if (lum > 1.0) band = vec3(0.1, 0.8, 0.2);
        if (lum > 4.0) band = vec3(1.0, 0.15, 0.05);
        L = band;
    }

    fragColor = vec4(L, 1.0);
}
