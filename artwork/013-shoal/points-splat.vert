// 013 — Shoal, the scatter pass
//
// Light through a water surface, landing on a floor. Each point is one photon:
// it picks a spot on the surface, reads the phase gradient there, and lands at
//
//     x(u) = u - a * grad(phi)(u)
//
// The picture is the DENSITY OF LANDINGS, and that density is the intensity by
// conservation of flux — there is nothing else to compute. Analytically the
// intensity is `sum over preimages of 1 / |det J|`, which diverges on the
// caustic and needs the preimages found by root-finding at every pixel.
// Scattering never evaluates that reciprocal and never looks for a preimage:
// the rays that arrive are the answer.
//
// So this is the second reason to scatter, on top of 010's. 010's was that the
// invariant measure of a map is not a function of position. This one's is that
// the quantity IS a function of position and is INFINITE exactly where the
// picture is. Both end at the same pass.
//
// THE SURFACE IS WATER, NOT NOISE, AND THAT WAS THE WHOLE PROBLEM. The first
// version used fbm as the phase. It made a convincing caustic that did not look
// like water and could not be made to flow, and those two complaints have one
// cause: fbm is a static random landscape, while a water surface is a sum of
// TRAVELLING waves whose speeds depend on their wavelengths. See
// `basics/field/wave.glsl` — the dispersion relation is the character of the
// material, and it is also the only honest escape from 001's finding that a
// composed field pushed through one moving offset can only ever translate.
//
// THE FLOOR IS WEDGE-SHAPED. `a` folds the propagation distance and the phase
// strength into one number (see `optics/lens.glsl`), and the caustic appears
// where `a` reaches the reciprocal of the local curvature — the local focal
// length. Sweeping `a` therefore sweeps the entire fold-and-cusp unfolding, so
// the piece tilts the floor and puts that whole one-parameter family in one
// frame: smooth at the shallow edge, first folds, then cusps, then a dense
// tangle at the deep one. Two things follow that are not decoration.
//
//   * The main knob cannot fail to reach the picture, because its full range is
//     on screen at once. Five pieces in this gallery have shipped with a knob
//     that turned out not to matter.
//   * The tone ramp cannot land on a driver that never moves, for the same
//     reason. That is the other failure this repo keeps repeating.

#include "core/math.glsl"
#include "hash/hash.glsl"
#include "sample/halton.glsl"
#include "field/wave.glsl"
#include "optics/glass.glsl"
#include "optics/lens.glsl"

// ---- the sea ---------------------------------------------------------------

uniform int   uWaves;     // @param 1 .. 16 = 9 step 1 "wave components"
uniform float uSwell;     // @param 4.0 .. 60.0 = 9.0 "swell wavenumber"
uniform float uTail;      // @param 0.0 .. 1.0 = 0.25 "short-wave calm"
uniform float uWind;      // @param -3.15 .. 3.15 = 0.7 "wind direction"

// HOW CONFUSED THE SEA IS, and it is the knob that decides what KIND of caustic
// this is rather than how much of one. A single wave is a cylindrical lens —
// `test/wave.test.ts` pins its Hessian as rank one — so a narrow spread is a
// swell arriving from one quarter and draws long parallel bands. Only
// components travelling in different directions make the determinant a genuine
// quadratic, and that is what closes the bands into the polygonal net everybody
// recognises from a pool floor.
uniform float uSpread;    // @param 0.0 .. 3.15 = 1.45 "directional spread"

// ONE TIME KNOB. The dispersion relation already sets how fast each component
// moves relative to the others; this only sets how fast the clock runs, as
// seconds per frame. Giving `flowWaveGravity` a speed as well would be two knobs on
// one degree of freedom — the same mistake `a` avoids by folding distance and
// relief together.
uniform float uRate;      // @param 0.0 .. 0.02 = 0.0012 "seconds per frame"

// ---- the floor -------------------------------------------------------------

// THE DEEP EDGE, IN UNITS OF THE SURFACE'S OWN FOCAL DISTANCE.
//
// A caustic appears where `a` reaches the reciprocal of the local curvature, so
// the only distance this field has an opinion about is 1/kappa. Stating the
// knob in absolute art units makes its useful range a function of every shape
// parameter, and the fbm version did exactly that: at six focal lengths past
// the first caustic the map is an EXPANSION by roughly (a kappa)^2 in area, so
// ninety-odd percent of the photons landed off the frame and the picture was a
// sparse dusting. It looked like too few points; it was too much distance.
//
// For a wave surface the scaling is exact rather than empirical. A component of
// steepness s and wavenumber k has amplitude s/k, so its Hessian goes as s*k
// and 1/kappa as 1/(s*k). Probed over 4088 points: the product
// `(1/kappa) * uSteep * uSwell` is unchanged when uSwell doubles (3533 against
// 3519 points below 0.5) and IDENTICAL when uSteep doubles — the law holds, so
// one constant serves the whole family. It is calibrated at the default
// component count and tail; changing those moves the typical focus, which is
// why they are shape knobs and this is not.
uniform float uFocus;     // @param 0.0 .. 4.0 = 1.5 "reach (1 = typical focus)"
uniform float uWedge;     // @param 0.0 .. 1.0 = 0.08 "shallow edge, as a fraction"
uniform float uSpan;      // @param 1.0 .. 2.0 = 1.30 "source width"

// THE RANGE STARTS ABOVE 1.5 ON PURPOSE. viz's point fragment uses a soft disc
// above that size and a flat mask at or below it — a size-1 point must cover
// its one fragment fully, whatever gl_PointCoord it lands on. The two regimes
// normalise differently, and the division by size^2 below is exact only for the
// disc. Measured on a contact sheet: mean light 0.3181 at size 1.5 against
// 0.1102 and 0.1111 at 2.5 and 4.0. The flat branch is not wrong; it is a
// different normalisation, and a knob that silently crosses between two of
// those is a knob whose brightness cannot be reasoned about.
uniform float uSplat;     // @param 1.6 .. 10.0 = 4.2 "splat size"

// Dispersion of the LIGHT, in units of real water — not to be confused with the
// dispersion of the WAVES above, which is a different relation on a different
// quantity and happens to share the word.
//
// Water's Cauchy B is 0.0032 um^2, so n(400) - n(550) = +0.0094 against an
// n - 1 of 0.3335: the deflection of a real water surface spreads by about 2.8%
// across the visible band, and the blue caustic focuses nearer than the red.
// uDisperse = 1 is exactly that. Larger values are exaggeration, and saying so
// in the unit is cheaper than saying so in a comment nobody reads.
uniform float uDisperse;  // @param 0.0 .. 25.0 = 6.0 "light dispersion (1 = water)"

// HOW DEEP THE WATER IS, IN OPTICAL DEPTHS AT 550 nm across the full wedge.
//
// Water is not a clear window, it is a coloured filter, and it is by far the
// most wavelength-selective thing in this piece: pure water absorbs red about a
// hundred times more strongly than blue. That single fact is why deep water is
// blue, and it is the reason a pool floor is not the same colour at the shallow
// end and the deep end.
//
// THE SAME WEDGE DRIVES IT. `depth` already sets the focal distance; here it
// also sets the path length, so one number now buys two things — the deep edge
// is both more folded AND darker and bluer, which is what a sloping floor
// actually looks like. Before this the wedge changed only the geometry, and the
// audit's tone line showed the consequence: p1 = 31, meaning the darkest cells
// were lifted and the picture had no true black anywhere.
//
// It is an exposure as well as a colour, because absorption removes flux. That
// is physics rather than a normalisation bug, but it does mean uMurk and uWhite
// have to be chosen together — they were, on a contact sheet.
uniform float uMurk;      // @param 0.0 .. 2.5 = 0.55 "water depth (optical depths)"

// MICROMETRES SQUARED, because that is what optIorCauchy takes — it converts
// the wavelength to um internally, and its doc comment says so. The first
// version of this file passed 3200, the same constant in nm^2, which is a
// factor of a million: n(400) came out 20000 instead of 1.02, the deflection
// was multiplied by about 226000, and every photon whose wavelength was not
// within a hair of 550 nm left the frame entirely.
//
// The picture said so plainly and I read it wrong twice. A sparse dusting of
// ISOLATED GREEN DOTS is not "too few photons" — it is every photon that did
// not disperse, which is to say the ones at the wavelength where the erroneous
// term happens to vanish. The colour was the diagnosis and it was in the first
// render.
const float SHOAL_CAUCHY_B = 0.0032;   // um^2, water
const float SHOAL_N_MINUS_1 = 0.3335;  // water at 550 nm

// Measured: the median of (1/kappa_max) * uSteep * uSwell at the default
// component count and tail. See the note on uFocus for the invariance check.
const float SHOAL_FOCAL = 0.25;

// The ladder step between components, shared with nothing. Deliberately not 2 —
// see `field/wave.glsl` on why an integer ratio makes the sum repeat.
const float SHOAL_RATIO = 1.37;

// STEEPNESS IS NOT A KNOB, AND THE AUDIT PROVED IT RATHER THAN SUGGESTED IT.
//
// It read 0.00 — the flat bottom of the table — and unlike most zeros there,
// this one is exact and provable. A component of steepness s and wavenumber k
// has amplitude s/k, so the gradient scales as s and the Hessian as s*k. The
// reach is calibrated as `a ~ 1/(s*k)` precisely so that `a*kappa` is
// invariant, and the displacement `a*grad` therefore scales as (1/s)*s = 1.
// EVERY term of the map x = u - a*grad is untouched by s.
//
// That is a property of the linear wave model: sinusoids only scale, they do
// not change profile, so once the reach follows the curvature there is nothing
// left for steepness to do. A Gerstner or Stokes surface would sharpen its
// crests as it steepened and the knob would come back with a real job.
//
// The proof is checkable and was checked: both this and uWeight below were
// removed by substituting their own defaults, so the reference image had to
// come back `unchanged` — which turns "provably vacuous" into a measurement.
const float SHOAL_STEEP = 0.22;

/**
 * Absorption of pure water against wavelength, relative to its value at 550 nm.
 *
 * The real coefficients rise steeply and unevenly across the visible band — in
 * inverse metres, roughly 0.006 at 400 nm, 0.026 at 500, 0.064 at 550, 0.24 at
 * 600 and 0.65 at 700. Normalised at 550 that is 0.09 / 0.40 / 1 / 3.8 / 10.
 *
 * A single exponential in wavelength captures it well enough for a picture:
 * this fit gives 0.12 / 0.49 / 1 / 2.0 / 8.5 at the same five points. It is
 * closest where it matters — the two ends, which set how blue the deep water
 * goes — and runs about half the true value in the orange. Stated rather than
 * hidden, because a fit presented as a spectrum is the kind of thing that gets
 * copied into the next piece as though it were data.
 *
 * Kept local to the artwork. It is one caller's material choice, not a
 * mechanism, and `basics/optics/glass.glsl` already owns the mechanism —
 * `optBeer`. If a second piece ever needs water's spectrum, it moves there
 * with a probe against published values rather than against this fit.
 */
float shoalAbsorbRel(float nm) {
    return exp((nm - 550.0) / 70.0);
}

void mainPoint(int index, out vec2 pos, out float size, out vec4 deposit) {
    // A LOW-DISCREPANCY SOURCE, ROTATED PER FRAME.
    //
    // The obvious stratification — index into an N x N grid of cells — needs
    // the shader to know the point count, which lives in meta.json. A count
    // below the grid leaves whole cells unsampled, which is bias rather than
    // noise, and nothing would report it. Halton is stratified for EVERY prefix
    // length, so the coupling simply does not exist.
    //
    // The per-frame offset is a Cranley-Patterson rotation: adding a constant
    // modulo one leaves the discrepancy of the sequence unchanged, so every
    // frame is an independent well-spread set rather than a rerun of the same
    // one. Replotting identical photons would make the picture brighter without
    // making it better, which looks like progress — 010's note, same trap.
    vec2 base = smpHalton23(index + 1);
    vec2 shift = hash22(vec2(float(uFrame) * 7.13, float(uSeed) * 3.77));
    vec2 t = fract(base + shift);

    // The source is the frame, widened: a photon moves by up to about `a` times
    // the gradient, so a surface cut to the frame would leave an unlit border
    // and, worse, a rim of missing preimages just inside it.
    float aspect = uFullRes.x / uFullRes.y;
    vec2 halfSpan = 0.5 * uSpan * vec2(max(aspect, 1.0), max(1.0 / aspect, 1.0));
    vec2 u = (t * 2.0 - 1.0) * halfSpan;

    // FRAME N MEANS N STEPS, so the clock is the frame counter and nothing else.
    // A wall clock here would make a still render of frame N and the Nth frame
    // of a sequence two different pictures, which is the one time invariant this
    // repo protects.
    float clock = float(uFrame) * uRate;

    FlowWaveSurface w = flowWaveGravity(u, clock, uWaves, uSwell, SHOAL_RATIO,
                                SHOAL_STEEP, uTail, uWind, uSpread, 1.0, uSeed);

    // The wedge: shallow at the left edge of the source, full reach at the
    // right. Taken from the SOURCE coordinate, which is what a floor of varying
    // depth actually gives — the ray is deflected by the water above it.
    float depth = mix(uWedge, 1.0, t.x);
    float a = uFocus * (SHOAL_FOCAL / max(SHOAL_STEEP * uSwell, 1.0e-3)) * depth;

    // Light dispersion. One wavelength per photon, integrated by the same loop
    // that does everything else stochastic here.
    float nm = optSampleWavelength(paStrat(5));
    float dev = (optIorCauchy(0.0, SHOAL_CAUCHY_B, nm)
               - optIorCauchy(0.0, SHOAL_CAUCHY_B, 550.0)) / SHOAL_N_MINUS_1;
    float aLam = a * (1.0 + uDisperse * dev);

    pos = optLensMap(u, w.grad, aLam);
    size = uSplat;

    // FLUX PER PHOTON, NOT BRIGHTNESS PER TEXEL.
    //
    // viz's point sprite spreads a disc whose total energy grows as size^2 and
    // deliberately does not normalise that away — a bigger brush really does
    // lay down more ink. Here the brush size is a reconstruction choice, not a
    // physical one: the photon carries a fixed quantum of light however wide it
    // is smeared. Dividing by size^2 is what makes uSplat a filter width rather
    // than a second exposure knob, and it is what lets the print use a wider
    // splat without the picture changing brightness. Measured across the
    // declared range: mean light 0.1102 at size 2.5 and 0.1111 at 4.0, a drift
    // of 0.8% for a brush nearly three times the area.
    // The flux per photon is ONE, not a knob. The audit read uWeight at 45.4 and
    // uWhite at 25.7, both comfortably alive — and they are exact inverses of
    // each other, because the image pass divides the accumulated flux by the
    // white point and nothing else stands between them. Two live knobs on one
    // degree of freedom is worse than one dead knob: it is a parameter space
    // whose sweeps explore a diagonal. uWhite survives because it has a unit,
    // flux per texel per frame; uWeight had none.
    // Beer-Lambert on the way down, per photon and per wavelength. Applying it
    // to the weight rather than to the colour is what makes it honest: `.a` is
    // the achromatic flux, so the deep end genuinely receives less light, and
    // `.rgb / .a` in the image pass shifts blue because the red photons are the
    // ones that did not arrive. Tinting the output afterwards would have looked
    // similar and conserved nothing.
    float trans = exp(-uMurk * shoalAbsorbRel(nm) * depth);

    float w0 = trans / (size * size);

    // The spectrum. optWavelengthToLinearSrgb is normalised so that uniformly
    // sampled wavelengths integrate to white, so the smooth regions come out
    // neutral by construction and colour appears only where the wavelengths
    // have been separated — which is to say, only on the folds.
    vec3 spec = optWavelengthToLinearSrgb(nm);

    // .a is the achromatic count and .rgb the spectral weight, so the image
    // pass can take tone from one and hue from the other. Keeping them apart
    // means the tone curve never has to guess how bright white is.
    deposit = vec4(spec * w0, w0);
}
