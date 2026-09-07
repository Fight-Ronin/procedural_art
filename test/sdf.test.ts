/**
 * Are the 2D primitives actually distances?
 *
 * Every field in `sdf/prim2d.glsl` renders a plausible picture whether or not
 * it is exact, because `aaStep` only ever looks at the sign and at values very
 * close to zero. So the two things exactness buys are both invisible on screen:
 *
 *   * antialiasing width. `pxSize()` is the correct footprint ONLY because
 *     |grad d| = 1. Where the field is steeper the edge comes out thin, where
 *     it is shallower the edge comes out soft, and both read as a rendering
 *     choice rather than a bug.
 *   * composition. `opRound`, `opOnion`, offsetting a stroke by its half-width
 *     all mean "move the boundary by exactly this much", which is only true of
 *     a real distance.
 *
 * The test is against the DEFINITION, not against a gradient: walk the shape's
 * own boundary, take the minimum distance from the query point, compare. No
 * derivatives, so no medial-axis exclusions and nothing to tune.
 *
 * THREE THINGS MAKE THAT COMPARISON HONEST, and the first version of this file
 * had none of them. Each cost a run of false failures on primitives that were
 * already correct, which is the expensive kind of wrong test: it points at the
 * code under test instead of at itself.
 *
 *   1. The walk lands exactly on every KINK — polygon vertices, the ends of an
 *      arc, the joins of a rounded box. At a smooth point a sampled minimum
 *      errs by O(step^2 / d); at a kink the error is first-order in the step,
 *      because the true minimum sits at a corner of the parametrisation. So the
 *      walk is piecewise with an equal share of t per piece and `M` is a
 *      multiple of the piece count. (sdBox: 600 failures before, 0 after.)
 *   2. A second, fine walk refines around the coarse winner. The analytic error
 *      bound it replaced modelled the boundary as locally straight, which holds
 *      for a segment and understates a curve — a circle of radius R seen from
 *      distance d recedes from its nearest point by s^2 R / (2 d |R - d|), not
 *      s^2 / (2 d). Refining drops the sampling residual four orders below
 *      float32 noise, so there is no geometry left in the tolerance to get
 *      wrong.
 *   3. The walk uses NO TRIGONOMETRY. Measured on this driver, a boundary built
 *      from sin/cos lands up to 2e-4 off the true circle — larger than anything
 *      this suite looks for, so the test was reporting SwiftShader's
 *      transcendentals as sdCircle being inexact. The half-angle rational
 *      parametrisation is ordinary arithmetic and lands within 1e-7. sdNgon
 *      calls atan/cos/sin itself and cannot dodge this, so it measures the
 *      driver's error at runtime and widens its own tolerance by it.
 *
 * The last probe is a CONTROL. `max(|p.x| - b.x, |p.y| - b.y)` is the box
 * everyone writes first: right sign, right zero set, 1-Lipschitz, and wrong —
 * it is the Chebyshev distance, so it under-reports by up to a factor of
 * sqrt(2) diagonally outside a corner. It must fail exactness and pass the
 * other two, which is what shows this suite measures exactness rather than
 * plausibility.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('sdf 2d');

const N = 64; // 4096 query points per shape

/**
 * Query points over a box a few times the shape, at an irrational stride so
 * they never land on the shape's own symmetry axes — where several of these
 * formulas change branch and where an error can cancel.
 */
const POINT = `
vec2 q = (pix + 0.5) / n;
vec2 sp = vec2(q.x * 2.7183 - 1.3591, q.y * 2.4142 - 1.2071);
`;

/**
 * The shared body. The probe's `decls` must define, at file scope:
 *   const int M;                sample count; a multiple of the piece count
 *   float shape(vec2 p);        the field under test
 *   vec2  boundary(float t);    t in [0,1] walks the zero set, equal t per piece
 *   bool  inside(vec2 p);       membership, computed WITHOUT calling shape()
 *   bool  signed_();            false for a curve, which has no interior
 *   bool  closed_();            true when t = 1 rejoins t = 0
 *   float slack();              tolerance for the exactness comparison
 */
const BODY = `${POINT}
float d = shape(sp);

// --- exactness: |d| is the distance to the zero set ------------------------
// Coarse walk to find which stretch of the boundary is nearest, then a fine
// walk over that stretch only.
//
// The refinement replaced an ANALYTIC error bound that was wrong, and wrong in
// an instructive way: modelling the boundary as locally straight gives
// sqrt(best^2 + (gap/2)^2), which holds for a segment and understates a curve.
// A circle of radius R seen from distance d recedes from its nearest point by
// s^2 R / (2 d |R - d|) rather than s^2 / (2 d), and the difference was enough
// to fail sdCircle at 40% of query points while sdCircle was exact. Refining
// drops the sampling residual four orders below float32 noise, so the
// tolerance below is arithmetic slack and nothing else — no geometry in it to
// get wrong.
float best2 = 1.0e18;
float ib = 0.0;
vec2 prev = boundary(0.0);
for (int i = 0; i <= M; ++i) {
    vec2 b = boundary(float(i) / float(M));
    float dd = dot(sp - b, sp - b);
    if (dd < best2) { best2 = dd; ib = float(i); }
    prev = b;
}
const int K = 256;
float t0 = (ib - 1.0) / float(M), t1 = (ib + 1.0) / float(M);
for (int i = 0; i <= K; ++i) {
    float t = mix(t0, t1, float(i) / float(K));
    // A closed curve wraps at the seam; an open one stops at its endpoints.
    t = closed_() ? fract(t + 1.0) : clamp(t, 0.0, 1.0);
    vec2 b = boundary(t);
    best2 = min(best2, dot(sp - b, sp - b));
}
float best = sqrt(best2);

// The walks below are trig-free, so what is left is float32 through length():
// baseSlack(). One shape overrides it, and says why. Either way this sits
// three to four orders below the control's error, which is geometric and runs
// to 0.1 and beyond.
float e = abs(abs(d) - best);
float exact = step(e, slack());

// --- 1-Lipschitz -----------------------------------------------------------
// Holds for an exact distance AND for any safe under-estimate, so it stays
// meaningful for shapes built with max()-based booleans, which are neither.
vec2 off = vec2(hash21(sp * 3.1) - 0.5, hash21(sp * 7.7 + 4.2) - 0.5) * 0.4;
float lip = step(abs(shape(sp + off) - d), length(off) * (1.0 + 1.0e-4) + 1.0e-6);

// --- sign ------------------------------------------------------------------
// Membership from an independent predicate. Points within a hair of the
// boundary are skipped: there both answers are right and float rounding picks
// one, so a disagreement says nothing.
float sgn = 1.0;
if (abs(d) > 2.0e-3) {
    sgn = signed_()
        ? step(0.5, (d < 0.0) == inside(sp) ? 1.0 : 0.0)
        : step(0.0, d);
}

ok = vec3(exact, lip, sgn);
`;

const LABELS: [string, string, string] = ['exact', '1-Lipschitz', 'sign'];

const PRELUDE = `
// Exact points on the unit circle, WITHOUT calling sin or cos.
//
// Measured on this driver (tools/probe.ts, 512 samples): a boundary walk built
// from sin/cos lands up to 2e-4 off the true circle. That is larger than any
// error this suite is looking for, so the first version of this file was
// measuring SwiftShader's transcendentals and reporting them as sdCircle being
// inexact — it failed at 68% of query points while sdCircle is exact to 4e-6
// in float64. The half-angle rational parametrisation is ordinary arithmetic
// and lands within 1e-7.
//
// u = tan(theta / 2), and the point returned is (cos theta, sin theta).
vec2 unitCirc(float u) {
    float k = 1.0 / (1.0 + u * u);
    return vec2((1.0 - u * u) * k, 2.0 * u * k);
}

/** Exact rotation by k right angles. */
vec2 rotQ(vec2 p, int k) {
    if (k == 1) return vec2(-p.y, p.x);
    if (k == 2) return -p;
    if (k == 3) return vec2(p.y, -p.x);
    return p;
}

/**
 * The whole circle, t in [0,1). Two half-turn charts, because one chart would
 * need u = infinity to reach its far point.
 */
vec2 circleWalk(float t) {
    float h = t < 0.5 ? 0.0 : 1.0;
    vec2 c = unitCirc(4.0 * (t - 0.5 * h) - 1.0);
    return h > 0.5 ? -c : c;
}

/** Default arithmetic slack: float32 through length() and nothing else. */
float baseSlack() { return 3.0e-5; }
`;

const BOX_WALK = `
const vec2 B = vec2(0.71, 0.43);
const int M = 512;                       // 4 edges
vec2 boundary(float t) {
    float u = t * 4.0;
    float k = floor(min(u, 3.9999)), f = u - k;
    if (k < 1.0) return vec2(mix(-B.x, B.x, f), -B.y);
    if (k < 2.0) return vec2(B.x, mix(-B.y, B.y, f));
    if (k < 3.0) return vec2(mix(B.x, -B.x, f), B.y);
    return vec2(-B.x, mix(B.y, -B.y, f));
}
bool inside(vec2 p) { return abs(p.x) < B.x && abs(p.y) < B.y; }
bool signed_() { return true; }
bool closed_() { return true; }
float slack() { return baseSlack(); }
`;

const s = await launch(5213);
try {
  const shapes: { name: string; decl: string }[] = [
    {
      name: 'sdCircle',
      decl: `
const float R = 0.62;
const int M = 512;
float shape(vec2 p) { return sdCircle(p, R); }
vec2  boundary(float t) { return R * circleWalk(t); }
bool  inside(vec2 p) { return dot(p, p) < R * R; }
bool  signed_() { return true; }
bool  closed_() { return true; }
float slack() { return baseSlack(); }
`,
    },
    {
      name: 'sdBox',
      decl: `${BOX_WALK}
float shape(vec2 p) { return sdBox(p, B); }
`,
    },
    {
      name: 'sdRoundBox',
      decl: `
const vec2 B = vec2(0.68, 0.47);
const float RR = 0.17;
const int M = 512;                       // 4 straights + 4 quarter arcs
float shape(vec2 p) { return sdRoundBox(p, B, RR); }
vec2 boundary(float t) {
    vec2 c = B - RR;
    float u = t * 8.0;
    float k = floor(min(u, 7.9999)), f = u - k;
    // Four straights and four quarter arcs. Every arc is the canonical quarter
    // unitCirc(u), u in [0,1], turned by a whole number of right angles, so
    // none of it needs trigonometry.
    if (k < 1.0) return vec2(mix(-c.x, c.x, f), -B.y);
    if (k < 2.0) return vec2(c.x, -c.y) + RR * rotQ(unitCirc(f), 3);
    if (k < 3.0) return vec2(B.x, mix(-c.y, c.y, f));
    if (k < 4.0) return c + RR * rotQ(unitCirc(f), 0);
    if (k < 5.0) return vec2(mix(c.x, -c.x, f), B.y);
    if (k < 6.0) return vec2(-c.x, c.y) + RR * rotQ(unitCirc(f), 1);
    if (k < 7.0) return vec2(-B.x, mix(c.y, -c.y, f));
    return -c + RR * rotQ(unitCirc(f), 2);
}
// Independent of sdRoundBox, which is sdBox(p, B - RR) - RR: the union of two
// rectangles and four discs, written out rather than reusing that identity.
bool inside(vec2 p) {
    vec2 c = B - RR;
    if (abs(p.x) <= c.x && abs(p.y) <= B.y) return true;
    if (abs(p.x) <= B.x && abs(p.y) <= c.y) return true;
    return distance(abs(p), c) < RR;
}
bool signed_() { return true; }
bool closed_() { return true; }
float slack() { return baseSlack(); }
`,
    },
    {
      name: 'sdNgon',
      decl: `
const float R = 0.66;
const float NS = 5.0;
const int M = 640;                       // 5 edges
float shape(vec2 p) { return sdNgon(p, R, NS); }
// One vertex on +y, so vertex k sits at angle 2 pi k / n measured from +y.
vec2 vert(float k) { float a = TAU * k / NS; return R * vec2(sin(a), cos(a)); }
vec2 boundary(float t) {
    float u = t * NS;
    float k = floor(min(u, NS - 1.0e-4));
    return mix(vert(k), vert(k + 1.0), u - k);
}
bool inside(vec2 p) {
    // p is inside a convex polygon iff it is on the same side of every edge.
    // Nothing here calls sdNgon.
    for (int i = 0; i < 16; ++i) {
        if (float(i) >= NS) break;
        vec2 a = vert(float(i)), b = vert(float(i) + 1.0);
        vec2 e = b - a;
        if ((p.x - a.x) * e.y - (p.y - a.y) * e.x < 0.0) return false;
    }
    return true;
}
bool signed_() { return true; }
bool closed_() { return true; }
/**
 * sdNgon is the one shape here that calls atan, cos and sin AT RUNTIME, so on
 * a given driver its accuracy is bounded by the driver's, not by the formula —
 * which is exact to 4e-6 when checked in float64 off the GPU. Rather than
 * assert a number, measure this machine's sin/cos error and scale by it, so
 * the bound tightens by itself on hardware that does better. SwiftShader lands
 * near 2e-4.
 */
float slack() {
    float e = 0.0;
    for (int i = 0; i < 64; ++i) {
        float a = float(i) * (TAU / 64.0);
        e = max(e, abs(length(vec2(cos(a), sin(a))) - 1.0));
    }
    return baseSlack() + 8.0 * R * e;
}
`,
    },
    {
      name: 'sdSegment',
      decl: `
const vec2 A = vec2(-0.63, -0.29);
const vec2 B = vec2(0.51, 0.66);
const int M = 512;
float shape(vec2 p) { return sdSegment(p, A, B); }
vec2  boundary(float t) { return mix(A, B, t); }
bool  inside(vec2 p) { return false; }
bool  signed_() { return false; }
bool  closed_() { return false; }
float slack() { return baseSlack(); }
`,
    },
    {
      name: 'sdArc',
      decl: `
// The half-aperture is given by its half-angle tangent so that both the arc's
// own sc pair and the boundary walk are exact arithmetic. U = 0.6 is
// 2 atan(0.6) = 1.0808 rad.
const float U = 0.6;
const float RA = 0.7;
const int M = 512;
vec2  scExact() { return unitCirc(U).yx; }   // (sin, cos) of the half-aperture
float shape(vec2 p) { return sdArc(p, scExact(), RA); }
vec2  boundary(float t) { return RA * unitCirc(mix(-U, U, t)).yx; }
bool  inside(vec2 p) { return false; }
bool  signed_() { return false; }
bool  closed_() { return false; }
float slack() { return baseSlack(); }
`,
    },
  ];

  for (const sh of shapes) {
    const img = await runProbe(s, {
      includes: ['sdf/prim2d.glsl', 'hash/hash.glsl'],
      decls: PRELUDE + sh.decl,
      body: BODY,
    }, N);
    const c = countFailures(img);
    check(`${sh.name} is an exact distance to its own boundary`,
      c.failed[0] === 0, describe(c, LABELS));
    check(`${sh.name} is 1-Lipschitz and correctly signed`,
      c.failed[1] === 0 && c.failed[2] === 0, describe(c, LABELS));
  }

  // --- sdArcSc ---------------------------------------------------------------
  //
  // The arc probe builds its own sc pair exactly, so the convenience wrapper is
  // otherwise untested — and the only thing that can be wrong with it is the
  // one thing that is easy to get wrong: which component is the sine. Compared
  // against the driver's own sin/cos, so this is an ordering check and carries
  // no accuracy claim.
  {
    const img = await runProbe(s, {
      includes: ['sdf/prim2d.glsl'],
      body: `
float a = ((pix.x + 0.5) / n) * 1.5 + 0.02;
vec2 sc = sdArcSc(a);
ok = vec3(
    step(abs(sc.x - sin(a)), 1.0e-7),
    step(abs(sc.y - cos(a)), 1.0e-7),
    // Not symmetric: a wrapper returning (cos, sin) would pass both of the
    // above at a = PI/4 and nowhere else, so require the pair to actually
    // differ over the sweep.
    step(1.0e-3, abs(sc.x - sc.y)));
`,
    }, 32);
    const c = countFailures(img);
    check('sdArcSc returns (sin, cos) in that order',
      c.failed[0] === 0 && c.failed[1] === 0,
      describe(c, ['x is sin', 'y is cos', 'sweep is not degenerate']));
  }

  // --- the control ----------------------------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['sdf/prim2d.glsl', 'hash/hash.glsl'],
      decls: PRELUDE + `${BOX_WALK}
// The Chebyshev box: right sign, right zero set, 1-Lipschitz, not a distance.
float shape(vec2 p) { vec2 q = abs(p) - B; return max(q.x, q.y); }
`,
      body: BODY,
    }, N);
    const c = countFailures(img);
    // Roughly a quarter of the plane is diagonally outside a corner, so a large
    // minority of points must disagree — not a handful.
    check('the Chebyshev box FAILS exactness (control)',
      c.failed[0] > c.total / 8, describe(c, LABELS));
    check('the Chebyshev box still passes Lipschitz and sign (control)',
      c.failed[1] === 0 && c.failed[2] === 0, describe(c, LABELS));
  }
} finally {
  await s.close();
}
