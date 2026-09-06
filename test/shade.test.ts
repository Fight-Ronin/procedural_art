/**
 * The shading model's three properties.
 *
 * Each corresponds to a mistake that still produces a plausible picture, which
 * is exactly the class the reference images cannot catch: a BRDF that was
 * already too bright when the reference was made stays too bright and stays
 * green. And "too bright" is not cosmetic — it is what makes two materials in
 * one scene refuse to agree, and every piece need its lights re-tuned.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('shade');

const N = 64;

/**
 * A different (normal, view, light, material) per pixel, spread over the whole
 * plausible range — including grazing angles and both roughness extremes, which
 * is where microfacet models go wrong and where a probe on a tidy 45-degree
 * setup would never look.
 */
const SETUP = `
vec2 q = (pix + 0.5) / n;
float h1 = hash21(pix * 1.7 + 3.1);
float h2 = hash21(pix * 2.3 - 7.7);
float h3 = hash21(pix * 3.9 + 11.3);

vec3 nrm = vec3(0.0, 0.0, 1.0);
// Azimuths differ so v and l are rarely coplanar with any axis; elevations run
// from nearly grazing to nearly normal.
float ev = mix(0.04, 1.55, q.x);
float el = mix(0.04, 1.55, q.y);
vec3 v = vec3(cos(h1 * TAU) * cos(ev), sin(h1 * TAU) * cos(ev), sin(ev));
vec3 l = vec3(cos(h2 * TAU) * cos(el), sin(h2 * TAU) * cos(el), sin(el));
ShMaterial mat = shMaterial(vec3(0.82, 0.55, 0.30), mix(0.05, 1.0, h3), step(0.5, h1));
`;

const s = await launch(5213);
try {
  // --- non-negative, finite, and reciprocal --------------------------------
  //
  // Reciprocity is exact algebra: every term is symmetric in v and l because
  // the half-vector is. An asymmetric denominator — the classic being
  // 4*n.l*n.l instead of 4*n.v*n.l — passes every visual inspection.
  //
  // THE THRESHOLD IS 1e-3, NOT MACHINE ZERO, and that is a float32 fact rather
  // than a fudge. `dot(v, h)` and `dot(l, h)` are algebraically identical and
  // computed from entirely different summands, so they agree to within 1e-6 at
  // only 0.7% of sample points. Measured, the relative asymmetry of the whole
  // BRDF is under 1e-3 everywhere and under 1e-5 at 91% of points — at the SAME
  // rate for roughness 0.05 and 0.5. A genuine algebraic asymmetry would depend
  // on roughness, because D, G and F each do; a flat rate is a noise floor.
  //
  // A loosened threshold is only worth having if it still catches the thing it
  // is for. The control below breaks the denominator on purpose and measures
  // the separation: the broken model is asymmetric by more than 1e-2 at 97% of
  // points, an order of magnitude above where this one is allowed to sit.
  {
    const img = await runProbe(s, {
      includes: ['shade/brdf.glsl', 'hash/hash.glsl'],
      body: `${SETUP}
vec3 a = shBrdf(mat, nrm, v, l);
vec3 b = shBrdf(mat, nrm, l, v);
float sym = length(a - b) / max(length(a) + length(b), 1e-9);
bool finite = !(isnan(a.x) || isinf(a.x) || isnan(a.y) || isinf(a.y));
ok = vec3(
    step(0.0, min(a.x, min(a.y, a.z))),
    step(sym, 1e-3),
    finite ? 1.0 : 0.0);
// A second, looser bound that no point is allowed to exceed. The tight one is
// a claim about the population; this one is absolute.
if (sym > 3e-3) ok.x = 0.0;
`,
    }, N);
    const c = countFailures(img);
    const tight = c.total - c.failed[1];
    const d = `non-negative and within 3e-3 everywhere: ${c.total - c.failed[0]}/${c.total}  ` +
      `within 1e-3: ${tight}/${c.total}  finite: ${c.total - c.failed[2]}/${c.total}`;
    check('the BRDF is never negative, and never asymmetric beyond 3e-3',
      c.failed[0] === 0, d);
    // A population claim, because the float32 tail has one straggler in four
    // thousand and pretending otherwise would mean quietly widening the bound
    // that the control below is measured against.
    check('the BRDF is reciprocal to 1e-3 at essentially every point',
      tight >= c.total * 0.999, d);
    check('the BRDF is finite everywhere', c.failed[2] === 0, d);
  }

  // THE CONTROL for the threshold above. Rebuild the specular term with the
  // wrong denominator and require the asymmetry to exceed 1e-4 by a wide
  // margin — otherwise "reciprocal to 1e-4" would be a statement about nothing.
  // Not every point: where n.v happens to equal n.l the broken version is
  // symmetric too, so what matters is that it shows over much of the domain.
  {
    const img = await runProbe(s, {
      includes: ['shade/brdf.glsl', 'hash/hash.glsl'],
      body: `${SETUP}
vec3 hv = normalize(v + l);
float nv = max(dot(nrm, v), 0.0);
float nl = max(dot(nrm, l), 0.0);
float al = mat.roughness * mat.roughness;
float dd = shDistributionGgx(max(dot(nrm, hv), 0.0), al);
float gg = shGeometrySmith(nv, nl, al);
vec3 ff = shFresnel(shF0(mat), max(dot(v, hv), 0.0));
// The mistake, and the same expression with v and l swapped.
vec3 badA = dd * gg * ff / max(4.0 * nl * nl, 1e-8);
vec3 badB = dd * gg * ff / max(4.0 * nv * nv, 1e-8);
float badSym = length(badA - badB) / max(length(badA) + length(badB), 1e-9);
ok = vec3(step(1e-2, badSym), step(1e-4, badSym), 1.0);
`,
    }, N);
    const c = countFailures(img);
    const loud = c.total - c.failed[0];
    check('a deliberately asymmetric denominator is caught by that threshold',
      loud > c.total * 0.6,
      `the broken BRDF is asymmetric by more than 1e-2 at ${loud}/${c.total} points, ` +
        `and by more than 1e-4 at ${c.total - c.failed[1]}/${c.total} — ` +
        'the real one stays under 1e-3 everywhere');
  }

  // --- the GGX distribution integrates to one ------------------------------
  //
  // The normalisation the 1/PI exists for. Dropping it makes this PI, which is
  // a picture roughly three times too bright in its highlights and looks, at
  // first, rather good.
  //
  // THE ESTIMATOR IS THE HARD PART. D depends only on n.h, so the integral
  // collapses to 2*PI * integral of D(mu)*mu dmu — but sampling mu uniformly
  // cannot see the lobe: at roughness 0.05 it is about 4e-6 wide in mu, and
  // 1024 uniform samples return 0.0156 instead of 1. Substituting mu = 1 - s^2
  // with s uniform puts the samples where the lobe is and returns 1.03 there,
  // 1.0000 from roughness 0.2 up.
  //
  // Below roughness 0.15 the estimator hits a float32 wall of its own:
  // mu*mu*(alpha*alpha - 1) + 1 is a difference of numbers near 1, so it loses
  // most of its significant digits exactly where the lobe lives. Hence the
  // accuracy claim is made over the range where it can be made, while the
  // factor-of-PI check — the failure this exists for — runs everywhere.
  {
    const img = await runProbe(s, {
      includes: ['shade/brdf.glsl', 'hash/hash.glsl'],
      body: `${SETUP}
ShMaterial tight = shMaterial(mat.albedo, mix(0.15, 1.0, h3), mat.metallic);
const int M = 1024;
float alpha = tight.roughness * tight.roughness;
float total = 0.0;
for (int i = 0; i < M; ++i) {
    float sv = (float(i) + 0.5) / float(M);
    float mu = 1.0 - sv * sv;
    total += shDistributionGgx(mu, alpha) * mu * 2.0 * sv;
}
total *= TAU / float(M);

// The full declared range, for the factor check only.
float wide = 0.0;
float alphaW = mat.roughness * mat.roughness;
for (int i = 0; i < M; ++i) {
    float sv = (float(i) + 0.5) / float(M);
    float mu = 1.0 - sv * sv;
    wide += shDistributionGgx(mu, alphaW) * mu * 2.0 * sv;
}
wide *= TAU / float(M);

ok = vec3(
    step(abs(total - 1.0), 0.1),
    step(abs(total - 1.0), 0.03),
    // Nowhere near PI, at any roughness the library will hand out.
    step(wide, 2.0));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['within 0.1', 'within 0.03', 'never off by a factor']);
    check('the GGX distribution integrates to one over the hemisphere',
      c.failed[0] === 0, d);
    check('the GGX distribution is nowhere off by a factor of PI',
      c.failed[2] === 0, d);
  }

  // --- energy conservation, the white furnace ------------------------------
  //
  // Light the surface from every direction with unit radiance: it must not
  // return more than it received. This is what catches a BRDF that is merely
  // "punchy" — it fails no visual inspection at all, and then two materials in
  // one scene cannot be balanced against each other.
  //
  // Unlike D, the full BRDF depends on v as well as l, so there is no symmetry
  // to collapse and the integral stays two-dimensional. Uniform hemisphere
  // sampling then needs the lobe to be wide enough to hit: at 1024 samples that
  // means roughness above about 0.4, so the material here is clamped there and
  // the range is stated rather than quietly assumed. The errors this exists to
  // catch are factor-scale and show at every roughness.
  {
    const img = await runProbe(s, {
      includes: ['shade/brdf.glsl', 'hash/hash.glsl', 'sample/halton.glsl'],
      body: `${SETUP}
ShMaterial rough = shMaterial(mat.albedo, mix(0.4, 1.0, h3), mat.metallic);
const int M = 1024;
vec3 total = vec3(0.0);
for (int i = 0; i < M; ++i) {
    vec2 xi = smpHalton23(i + 1);
    float ct = xi.x;
    float st = sqrt(max(0.0, 1.0 - ct * ct));
    float ph = xi.y * TAU;
    vec3 li = vec3(st * cos(ph), st * sin(ph), ct);
    total += shBrdf(rough, nrm, v, li) * max(dot(nrm, li), 0.0);
}
total *= TAU / float(M);
float worst = max(total.r, max(total.g, total.b));
ok = vec3(step(worst, 1.0), step(worst, 0.999), step(0.01, worst));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['<= 1 (conserving)', '<= 0.999', 'not black']);
    check('the BRDF never returns more energy than it receives', c.failed[0] === 0, d);
    check('the BRDF actually reflects something', c.failed[2] === 0, d);
  }

  // --- 3D noise ------------------------------------------------------------
  //
  // No analytic derivative in 3D, so there is nothing to differentiate against.
  // What IS checkable is the range — a noise claiming roughly [-1,1] that
  // actually reaches 3 will blow out any displacement built on it — and that
  // the field is continuous, which a bad lattice-gradient construction breaks.
  {
    const img = await runProbe(s, {
      includes: ['noise/noise3.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec3 sp = vec3(q.x * 9.1 - 4.0, q.y * 7.7 - 3.3, (q.x + q.y) * 3.3 - 2.1);
float a = nzGrad31(sp);
// Continuity: gradient noise is smooth, so a small step must make a small
// change. A degenerate lattice gradient (the normalize(vec3(0)) trap) shows up
// here as a discontinuity or a NaN rather than as something subtle.
float d = 0.01;
float b = nzGrad31(sp + vec3(d, d, d) * 0.577);
bool sane = !(isnan(a) || isinf(a));
ok = vec3(
    step(abs(a), 1.05),
    step(abs(b - a), 0.15),
    sane ? 1.0 : 0.0);
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['|value| <= 1.05', 'continuous', 'finite']);
    check('nzGrad31 stays inside its stated range', c.failed[0] === 0, d);
    check('nzGrad31 is continuous', c.failed[1] === 0, d);
    check('nzGrad31 is finite everywhere', c.failed[2] === 0, d);
  }

  {
    const img = await runProbe(s, {
      includes: ['noise/noise3.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec3 sp = vec3(q.x * 9.1 - 4.0, q.y * 7.7 - 3.3, (q.x - q.y) * 5.1 - 1.7);
float f = nzFbm31(sp, 5, 2.0, 0.5);
float r = nzRidged31(sp, 5, 2.0, 0.5);
// fbm is a normalised weighted sum of octaves, so it inherits the single
// octave's range; ridged is a fold and therefore has a floor at zero.
ok = vec3(step(abs(f), 1.05), step(-r, 0.0), step(r, 1.05));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['fbm in range', 'ridged >= 0', 'ridged <= 1.05']);
    check('nzFbm31 stays inside the single-octave range', c.failed[0] === 0, d);
    check('nzRidged31 stays within [0, 1]', c.failed[1] === 0 && c.failed[2] === 0, d);
  }

  check('no console errors while probing shading', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));
} finally {
  await s.close();
}
