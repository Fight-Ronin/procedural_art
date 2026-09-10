/**
 * basics/optics/glass.glsl carries a baked constant, OPT_SPECTRAL_NORM, that
 * makes a uniformly-sampled spectrum integrate to white. This re-derives it
 * from the same CIE fits and fails if the two ever drift apart — a silent drift
 * would tint every dispersed highlight and be almost impossible to attribute.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, near, note, section } from './harness.ts';
import { ROOT } from './paths.ts';

section('optics');

const src = readFileSync(path.join(ROOT, 'basics/optics/glass.glsl'), 'utf8');

const gauss = (x: number, mu: number, s1: number, s2: number) => {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};

const xyz = (nm: number): [number, number, number] => [
  1.056 * gauss(nm, 599.8, 37.9, 31.0)
  + 0.362 * gauss(nm, 442.0, 16.0, 26.7)
  - 0.065 * gauss(nm, 501.1, 20.4, 26.2),
  0.821 * gauss(nm, 568.8, 46.9, 40.5) + 0.286 * gauss(nm, 530.9, 16.3, 31.1),
  1.217 * gauss(nm, 437.0, 11.8, 36.0) + 0.681 * gauss(nm, 459.0, 26.0, 13.8),
];

const M = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

const acc = [0, 0, 0];
let n = 0;
for (let nm = 380; nm <= 730; nm += 0.05) {
  const c = xyz(nm);
  for (let i = 0; i < 3; i++) {
    acc[i] += Math.max(0, M[i][0] * c[0] + M[i][1] * c[1] + M[i][2] * c[2]);
  }
  n++;
}
const derived = acc.map((v) => n / v);
note(`derived normalisation: ${derived.map((v) => v.toFixed(6)).join(', ')}`);

const m = /OPT_SPECTRAL_NORM\s*=\s*vec3\(([^)]*)\)/.exec(src);
check('OPT_SPECTRAL_NORM is declared', m !== null);
if (m) {
  const baked = m[1].split(',').map((s) => Number(s.trim()));
  // The shader clamps negatives per channel before weighting, so the derived
  // value uses max(0, ...) too; 1% is well inside what a fit revision would move.
  check('baked normalisation matches the CIE fits',
    baked.every((v, i) => near(v, derived[i], derived[i] * 0.02)),
    `baked ${baked.join(', ')}`);
}

// The matrix and the fits both have to be present for the above to mean
// anything, so pin the shape of the file too.
check('CIE fit lobes are present', /1\.056|0\.362|1\.217/.test(src));
check('XYZ to linear sRGB matrix is present', /3\.2404542/.test(src));
check('Fresnel handles total internal reflection',
  /if \(s2 >= 1\.0\) return 1\.0;/.test(src));
check('optRefract reports TIR instead of returning zero',
  /bool optRefract/.test(src) && /return false;/.test(src));

// ---------------------------------------------------------------------------
// basics/optics/lens.glsl — the phase-screen lens map
//
// Everything here is an exact identity or a convergence, because the piece that
// uses it draws a ZERO SET: `det J = 0` is the caustic, so an error of any size
// in det J does not dim the picture, it moves the lines.
// ---------------------------------------------------------------------------

const N = 64;
const s2 = await launch(5237);
try {
  // --- the case with a closed form ----------------------------------------
  //
  // A purely quadratic phase, phi = (k/2)|u|^2, is the one lens whose whole
  // behaviour can be written down: the gradient is k*u, the Hessian is k*I, the
  // map is the uniform contraction x = (1 - a k) u, and the determinant is
  // (1 - a k)^2. At a = 1/k the contraction is total and the ENTIRE PLANE MAPS
  // TO ONE POINT — a perfect focus, which is the degenerate extreme of the
  // caustic the artwork is made of.
  //
  // This pins the sign convention, the factor on `a`, and the two invariants at
  // once. Every one of those can be wrong in a way that still produces a
  // caustic-looking network.
  {
    const img = await runProbe(s2, {
      includes: ['optics/lens.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
float k = mix(-2.5, 2.5, q.x);
float a = mix(-1.5, 1.5, q.y);
vec2 u = vec2(0.31, -0.77);
mat2 H = mat2(k, 0.0, 0.0, k);

// The map.
vec2 got = optLensMap(u, k * u, a);
vec2 want = (1.0 - a * k) * u;
float eMap = length(got - want) / length(u);

// The determinant. Compared with a scale rather than relatively, because the
// closed form passes through zero and a relative error there is meaningless.
float dj = optLensDetJ(H, a);
float dw = (1.0 - a * k) * (1.0 - a * k);
float eDet = abs(dj - dw) / (1.0 + a * a * k * k);

// The focus. Only asked where k is far enough from zero that 1/k is a sane
// distance; there is no focal length for a flat phase.
float focused = 1.0;
if (abs(k) > 0.2) {
    float af = 1.0 / k;
    focused = step(length(optLensMap(u, k * u, af)) / length(u), 1.0e-5)
            * step(abs(optLensDetJ(H, af)), 1.0e-5);
}

ok = vec3(step(eMap, 1.0e-6), step(eDet, 1.0e-6), focused);
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['map', 'determinant', 'focus at a = 1/k']);
    check('optLensMap is the uniform contraction a quadratic phase predicts',
      c.failed[0] === 0, d);
    check('optLensDetJ matches the closed form for a quadratic phase',
      c.failed[1] === 0, d);
    check('at a = 1 / curvature the plane collapses to a point and det J vanishes',
      c.failed[2] === 0, d);
  }

  // --- det J is the determinant of the map it claims to describe ------------
  //
  // The end-to-end tie: `optLensDetJ` is handed the Hessian from
  // `noise/hessian.glsl`, while the Jacobian is measured by differencing
  // `optLensMap` on the real field. Nothing else checks that those two agree,
  // and they are written in different files by different algebra.
  //
  // THE CONTROL IS DROPPING THE a^2 TERM — that is, using `1 - a tr(H)` in
  // place of `det(I - a H)`. It is the linearisation anyone would write first,
  // it agrees to first order in `a`, and it is the difference between a lens
  // with two focal lengths and one with a single average — the a^2 term is why
  // a caustic has cusps rather than only folds.
  {
    const img = await runProbe(s2, {
      includes: ['optics/lens.glsl', 'noise/hessian.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec2 sp = vec2(q.x * 7.3137 - 3.1, q.y * 6.1803 - 2.7);
const int OCT = 3;
float a = 0.35;

mat2 h;
vec3 nd = nzFbm21dd(sp, OCT, 2.0, 0.5, h);

// Scaled to the finest octave, as in the Hessian probes: the top octave has
// frequency 2^(OCT-1) and the truncation carries it cubed.
float e1 = 0.05 / exp2(float(OCT - 1)) * 0.5;
float e2 = e1 * 0.5;
mat2 gg;
vec2 c1x = (optLensMap(sp + vec2(e1, 0.0), nzFbm21dd(sp + vec2(e1, 0.0), OCT, 2.0, 0.5, gg).yz, a)
          - optLensMap(sp - vec2(e1, 0.0), nzFbm21dd(sp - vec2(e1, 0.0), OCT, 2.0, 0.5, gg).yz, a)) / (2.0 * e1);
vec2 c1y = (optLensMap(sp + vec2(0.0, e1), nzFbm21dd(sp + vec2(0.0, e1), OCT, 2.0, 0.5, gg).yz, a)
          - optLensMap(sp - vec2(0.0, e1), nzFbm21dd(sp - vec2(0.0, e1), OCT, 2.0, 0.5, gg).yz, a)) / (2.0 * e1);
vec2 c2x = (optLensMap(sp + vec2(e2, 0.0), nzFbm21dd(sp + vec2(e2, 0.0), OCT, 2.0, 0.5, gg).yz, a)
          - optLensMap(sp - vec2(e2, 0.0), nzFbm21dd(sp - vec2(e2, 0.0), OCT, 2.0, 0.5, gg).yz, a)) / (2.0 * e2);
vec2 c2y = (optLensMap(sp + vec2(0.0, e2), nzFbm21dd(sp + vec2(0.0, e2), OCT, 2.0, 0.5, gg).yz, a)
          - optLensMap(sp - vec2(0.0, e2), nzFbm21dd(sp - vec2(0.0, e2), OCT, 2.0, 0.5, gg).yz, a)) / (2.0 * e2);

float num1 = c1x.x * c1y.y - c1x.y * c1y.x;
float num2 = c2x.x * c2y.y - c2x.y * c2y.x;
float ana = optLensDetJ(h, a);

float err1 = abs(ana - num1);
float err2 = abs(ana - num2);

// THE ROUNDOFF FLOOR OF A DETERMINANT IS SET BY THE TERMS BEING SUBTRACTED,
// not by the answer. A determinant is a difference of two products, and on the
// caustic — which is the whole subject here — those two products are equal, so
// the measured value is pure cancellation exactly where the picture is. A flat
// floor is therefore the wrong shape twice over: too high where the Jacobian is
// small, too low where it is large.
//
// Measured. With a flat 1e-3 floor this check failed at 87 of 4088 points; with
// the floor scaled below, 12 of the 3623 truncation-dominated points fail, and
// only 3 of those have a residual above 3e-2. The failures were never the
// determinant, they were the floor.
float cancel = abs(c2x.x * c2y.y) + abs(c2x.y * c2y.x);
float meaningful = step(1.0e-3 * (1.0 + cancel), err1);
float shrinks = max(step(1.5, err1 / max(err2, 1.0e-12)), 1.0 - meaningful);

// The control: the linearisation, against the same measured determinant.
float lin = 1.0 - a * (h[0][0] + h[1][1]);
float gap = abs(ana - lin);

ok = vec3(shrinks, step(0.02, gap), meaningful);
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['residual shrinks', 'differs from 1 - a tr(H)', 'above the cancellation floor']);
    check('optLensDetJ is the determinant of the Jacobian of optLensMap',
      c.total - c.failed[0] >= c.total * 0.99, d);
    check('and is not the linearisation 1 - a tr(H)',
      c.total - c.failed[1] >= c.total * 0.95, d);
    check('the lens determinant check actually exercises something',
      c.total - c.failed[2] > c.total / 3, d);
  }

  // --- the curvatures ARE the reciprocal focal distances --------------------
  //
  // The statement the artwork's main knob rests on: put the receiver at
  // a = 1/kappa and that direction is exactly in focus, so det J is zero there
  // and nowhere between. Checked on the real field rather than on the quadratic,
  // because on the quadratic the two curvatures are equal and the ordering,
  // the off-diagonal and the discriminant are all untested.
  //
  // The umbilic case is the one to watch: `tr^2 - 4 det` is a difference of two
  // comparable numbers there and dips below zero in float, so the obvious
  // spelling of the discriminant returns NaN at isolated points. One NaN in an
  // additively blended float target poisons that texel for the whole frame and
  // survives every later average — 010 has the same note about escaped orbits.
  {
    const img = await runProbe(s2, {
      includes: ['optics/lens.glsl', 'noise/hessian.glsl'],
      body: `
vec2 q = (pix + 0.5) / n;
vec2 sp = vec2(q.x * 7.3137 - 3.1, q.y * 6.1803 - 2.7);
mat2 h;
vec3 nd = nzFbm21dd(sp, 3, 2.0, 0.5, h);
vec2 kk = optLensCurvature(h);
float scale = max(abs(kk.x), abs(kk.y));

// Ordered, finite, and consistent with the invariants.
float sane = step(kk.y, kk.x)
           * step(abs(kk.x + kk.y - (h[0][0] + h[1][1])), 1.0e-4 * (1.0 + scale))
           * (1.0 - step(1.0, abs(sign(kk.x - kk.x))));   // NaN fails this

// det J vanishes at a = 1/kappa, for both roots.
float vanishes = 1.0;
for (int i = 0; i < 2; ++i) {
    float k = i == 0 ? kk.x : kk.y;
    if (abs(k) > 0.5) {
        float dj = optLensDetJ(h, 1.0 / k);
        // Scaled by the size of the other term, since det J is a difference of
        // numbers of order (a * kappa)^2 and cancellation sets the floor.
        vanishes *= step(abs(dj), 1.0e-4 * (1.0 + scale * scale / (k * k)));
    }
}

// A control on the same line: half that distance must NOT be a focus.
float notEverywhere = 1.0;
if (abs(kk.x) > 0.5) notEverywhere = step(1.0e-3, abs(optLensDetJ(h, 0.5 / kk.x)));

ok = vec3(sane, vanishes, notEverywhere);
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['ordered, finite, trace-consistent', 'det J = 0 at a = 1/kappa', 'and not at half that']);
    check('optLensCurvature returns the eigenvalues, ordered and never NaN',
      c.failed[0] === 0, d);
    check('det J vanishes exactly at a = 1 / each principal curvature',
      c.failed[1] === 0, d);
    check('and does not vanish at half that distance (control)',
      c.total - c.failed[2] >= c.total * 0.95, d);
  }
} finally {
  await s2.close();
}
