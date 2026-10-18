/**
 * 014's phase field: the stencils, the anisotropy, and what the simulation
 * conserves and converges to.
 *
 * Every check here is an exact property or a number from an independent
 * implementation, never "looks like a dendrite". A phase-field code with a
 * transposed cross term or a flipped driving force still grows something
 * plausible — the prototype grew a convincing crystal with the five-point
 * stencil, it was simply square — so the eye is the wrong instrument.
 *
 *   1. The nine-point stencils are isotropic to O(h^4) and the five-point ones
 *      are not. The five-point pair is the CONTROL: the threshold is only
 *      evidence if the stencil it is meant to reject fails it.
 *   2. pfEpsDir (complex power, what the piece runs) equals pfEps at
 *      atan(g) (the textbook form) — including at g = 0, where atan is
 *      undefined and the piece relies on the branch being right.
 *   3. sum(T - K phi) is conserved: every stencil is a sum over links and the
 *      heat released equals the ice formed. What it CANNOT see, found by
 *      review: a torus conserves it exactly too, and with the noise off K dphi/dt
 *      from the right-hand side equals K (phiN - phi) to rounding. Walls are
 *      held by the cross-check (4) only once heat reaches them.
 *   4b. The arms point where theta0 says. Every other number here is blind to
 *      a rotation — found by review: theta0 = 0 instead of pi/2 passes the
 *      radius, the frozen-cell count and both means — so the direction of the
 *      sixfold mode is checked on its own.
 *   4. The GLSL matches the numpy prototype the design was measured on
 *      (claude/014-prototype-kob.py), step for step, with the noise off. Two
 *      independent implementations agreeing is the only evidence that the
 *      operators are the ones written in the design; either one alone could
 *      carry a bug its own tests were written around.
 *   5. It converges to the right equilibrium: the water warms to the melting
 *      point and the ice fraction is 1/K plus the seed. Conservation alone
 *      cannot see a sign error in the driving force — a crystal that melts
 *      conserves T - K phi just as well — so this is the check that does.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch, type Session } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('crystal');

/** Reference numbers from the numpy prototype, float64. See (4). */
const NUMPY = {
  n: 64,
  steps: 360,
  rmax: 17.5,
  meanPhi: 0.19335152051573112,
  meanT: 0.317710471303316,
  solid: 787,
};

/** Parameters that make a run deterministic and comparable to the prototype. */
const PLAIN = { uK: 1.8, uTeqA: 1.0, uTeqB: 1.0, uSwitch: 1, uEpochs: 0, uWobble: 0, uNoise: 0 };
const SUBSTEPS = 12; // meta.json; frame N is N * 12 steps

interface State { width: number; height: number; data: number[] }

async function runTo(s: Session, grid: number, frame: number, values: Record<string, number>): Promise<State[]> {
  return s.page.evaluate(([grid, frame, values]) => {
    const pa = window.__pa;
    pa.loadValues(values as Record<string, unknown>);
    // Both passes: the flux pass is read texel-for-texel by the update.
    pa.setPassSize('flux', grid as number);
    pa.setPassSize('ice', grid as number);
    pa.seekTo(64, 64, 0);
    const first = pa.passState('ice');
    pa.seekTo(64, 64, frame as number);
    return [first, pa.passState('ice')];
  }, [grid, frame, values] as const);
}

function channel(st: State, c: number): number[] {
  const out: number[] = [];
  for (let i = c; i < st.data.length; i += 4) out.push(st.data[i]);
  return out;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/**
 * Outermost phi = 1/2 crossing along 720 rays from the centre, bilinear,
 * 0.25-cell steps — the prototype's radius_profile, so the numbers compare.
 */
function radiusProfile(st: State): number[] {
  const { width: w, height: h } = st;
  const phi = channel(st, 0);
  const at = (x: number, y: number) => {
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    return (phi[y0 * w + x0] * (1 - fx) + phi[y0 * w + x1] * fx) * (1 - fy)
         + (phi[y1 * w + x0] * (1 - fx) + phi[y1 * w + x1] * fx) * fy;
  };
  const rs: number[] = [];
  for (let a = 0; a < 720; a++) {
    const th = (a / 720) * 2 * Math.PI;
    let r = 0;
    for (let s = 0; s < w / 2 - 1; s += 0.25) {
      if (at(w / 2 + Math.cos(th) * s, h / 2 + Math.sin(th) * s) >= 0.5) r = s;
    }
    rs.push(r);
  }
  return rs;
}

/**
 * Direction of the sixfold mode of r(theta), in degrees modulo 60: the angle
 * of an arm. Rows of the state are bottom-up, so +y is up and an arm straight
 * up is 90, i.e. 30 modulo 60.
 */
function armAngle(rs: number[]): number {
  let re = 0, im = 0;
  rs.forEach((r, a) => {
    const th = (a / rs.length) * 2 * Math.PI;
    re += r * Math.cos(6 * th);
    im += r * Math.sin(6 * th);
  });
  const deg = (Math.atan2(im, re) * 180) / Math.PI / 6;
  return ((deg % 60) + 60) % 60;
}

const s = await launch(5241);
try {
  // --- 1. stencil isotropy -------------------------------------------------
  {
    // A plane wave cos(k.x) at |k| h = 0.6, one direction per pixel column
    // from 0 to 90 degrees. The exact Laplacian is -|k|^2 cos in every
    // direction; how much the stencil's answer VARIES with direction is the
    // anisotropy. Measured: nine-point 1.8e-4 (Laplacian) and 5.2e-4
    // (gradient), five-point 1.5e-2 and 2.9e-2 — two orders apart, so the
    // thresholds sit in the gap.
    const img = await runProbe(s, {
      includes: ['pde/stencil.glsl'],
      decls: `
void wave(float th, bool cosine, out float s[9]) {
    vec2 k = 0.6 * vec2(cos(th), sin(th));
    for (int e = 0; e < 9; ++e) {
        float ph = dot(k, vec2(float(e % 3 - 1), float(e / 3 - 1)));
        s[e] = cosine ? cos(ph) : sin(ph);
    }
}
`,
      body: `
float th = (pix.x + 0.5) / n * 1.5707963;
float c[9], sn[9], c0[9], s0[9];
wave(th, true, c);  wave(th, false, sn);
wave(0.0, true, c0); wave(0.0, false, s0);
float lap9 = abs(pdeLap9(c, 1.0) - pdeLap9(c0, 1.0)) / 0.36;
float grd9 = abs(length(pdeGrad9(sn, 1.0)) - length(pdeGrad9(s0, 1.0))) / 0.6;
float lap5 = abs(pdeLap5(c, 1.0) - pdeLap5(c0, 1.0)) / 0.36;
ok = vec3(lap9 < 1.0e-3 ? 1.0 : 0.0, grd9 < 2.0e-3 ? 1.0 : 0.0, lap5 < 1.0e-3 ? 1.0 : 0.0);
`,
    }, 64);
    const c = countFailures(img);
    const labels: [string, string, string] = ['lap9 isotropic', 'grad9 isotropic', 'lap5 (control)'];
    check('the nine-point Laplacian is isotropic', c.failed[0] === 0, describe(c, labels));
    check('the nine-point gradient is isotropic', c.failed[1] === 0, describe(c, labels));
    check('the five-point Laplacian fails the same threshold (control)', c.failed[2] > 0,
      `${c.failed[2]} of ${c.total} directions over threshold`);
  }

  // --- 2. pfEpsDir equals pfEps(atan) ---------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['hash/hash.glsl', 'pde/phasefield.glsl'],
      body: `
vec2 g = (hash22(pix + 0.37) - 0.5) * pow(10.0, 4.0 * hash21(pix + 7.1) - 2.0);
if (pix.x == 0.0 && pix.y == 0.0) g = vec2(0.0);
float th0 = hash21(pix + 3.3) * 6.2831853;
float j = 6.0;
vec2 cs0 = vec2(cos(j * th0), sin(j * th0));
vec2 a = pfEpsDir(g, 0.01, 0.02, 6, cs0);
vec2 b = pfEps(pfTheta(g), 0.01, 0.02, j, th0);
// Relative to each component's amplitude. 2e-3, not tighter, and the reason is
// the REFERENCE: atan in float32 is good to about 1e-4 rad, and the angle is
// multiplied by j = 6 before the sine, so pfEps itself carries ~6e-4. Measured:
// 127 of 4088 points over 2e-4, all in eps', none over 2e-3; restricting theta0
// to one sector changed nothing, so it is not argument range in sin.
float rel = max(abs(a.x - b.x) / 0.01, abs(a.y - b.y) / (0.01 * 6.0 * 0.02));
ok = vec3(rel < 2.0e-3 ? 1.0 : 0.0,
          (g == vec2(0.0)) ? (all(lessThan(abs(a - b), vec2(1.0e-9))) ? 1.0 : 0.0) : 1.0,
          (isnan(a.x) || isnan(a.y)) ? 0.0 : 1.0);
`,
    }, 64);
    const c = countFailures(img);
    const labels: [string, string, string] = ['agrees', 'g = 0 branch', 'finite'];
    check('pfEpsDir agrees with pfEps at atan(g)', c.failed[0] === 0, describe(c, labels));
    check('and takes the same value where the gradient is zero', c.failed[1] === 0, describe(c, labels));
    check('and is never NaN', c.failed[2] === 0, describe(c, labels));
  }

  check('no console errors from the probes', s.consoleErrors.length === 0, s.consoleErrors.join('\n'));
} finally {
  await s.close();
}

// A fresh session for the piece itself. The probes write and delete temporary
// pieces under artwork/, and the dev server's reload after the last deletion
// can land on the next page load — the same reason optics.test.ts opens a
// second session.
const p = await launch(5245);
try {
  await p.open('?p=014');

  // --- 3 & 4. conservation, and the numpy cross-check -----------------------
  {
    const frames = NUMPY.steps / SUBSTEPS;
    const t0 = Date.now();
    const [first, last] = await runTo(p, NUMPY.n, frames, PLAIN);
    const K = PLAIN.uK;
    const inv = (st: State) => sum(channel(st, 1)) - K * sum(channel(st, 0));
    const scale = K * sum(channel(last, 0));
    const drift = Math.abs(inv(last) - inv(first)) / scale;
    check('sum(T - K phi) is conserved (relative drift < 1e-5)', drift < 1e-5,
      `drift ${drift.toExponential(2)} over ${NUMPY.steps} steps, float32`);

    const phi = channel(last, 0), T = channel(last, 1);
    const cells = phi.length;
    const meanPhi = sum(phi) / cells, meanT = sum(T) / cells;
    const solid = phi.filter((v) => v >= 0.5).length;
    const rs = radiusProfile(last);
    const rmax = Math.max(...rs);
    const arm = armAngle(rs);
    check('one arm points straight up (sixfold mode at 90 degrees)',
      Math.abs(arm - 30) < 1, `arm at ${arm.toFixed(2)} modulo 60; expected 30`);
    note(`GLSL  rmax ${rmax}  mean phi ${meanPhi.toFixed(5)}  mean T ${meanT.toFixed(5)}  solid ${solid}`);
    note(`numpy rmax ${NUMPY.rmax}  mean phi ${NUMPY.meanPhi.toFixed(5)}  mean T ${NUMPY.meanT.toFixed(5)}  solid ${NUMPY.solid}`);
    check('the tip is where the prototype puts it (within 0.5 cell)',
      Math.abs(rmax - NUMPY.rmax) <= 0.5, `${rmax} vs ${NUMPY.rmax}`);
    // 1e-4, not looser, and measured rather than chosen: the two implementations
    // agree to ~5e-6. With t3 replaced by the common simplification
    // eps^2 lap phi (dropping grad(eps^2) . grad phi), these two checks go red
    // and EVERY other check in this suite stays green — tip, frozen-cell
    // count, conservation, equilibrium. At 1e-3 nothing here would see it.
    check('the ice fraction matches the prototype (relative 1e-4)',
      Math.abs(meanPhi - NUMPY.meanPhi) / NUMPY.meanPhi < 1e-4,
      `${meanPhi.toFixed(6)} vs ${NUMPY.meanPhi.toFixed(6)}`);
    check('the heat released matches the prototype (relative 1e-4)',
      Math.abs(meanT - NUMPY.meanT) / NUMPY.meanT < 1e-4,
      `${meanT.toFixed(6)} vs ${NUMPY.meanT.toFixed(6)}`);
    check('the frozen cells match the prototype (within 2 cells)',
      Math.abs(solid - NUMPY.solid) <= 2, `${solid} vs ${NUMPY.solid}`);
    check('the t_s channel records exactly the frozen cells',
      channel(last, 2).every((v, i) => (v >= 0) === (phi[i] >= 0.5) || Math.abs(phi[i] - 0.5) < 0.05),
      'every cell with t_s >= 0 has phi >= 1/2, and the reverse, away from the interface');
    note(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // --- 5. equilibrium -------------------------------------------------------
  {
    // 32^2 at K = 1.6, 600 steps: the prototype reaches mean phi 0.6852 against
    // a target of 0.6924 and liquid T 0.986. The liquid settles BELOW the
    // melting point, at 0.993 in a long run — that is Gibbs-Thomson, a curved
    // interface melts lower — so the bound on T is one-sided from above.
    const K = 1.6;
    const [first, last] = await runTo(p, 32, 600 / SUBSTEPS, { ...PLAIN, uK: K });
    const seed = sum(channel(first, 0)) / (32 * 32);
    const target = 1 / K + seed;
    const phi = channel(last, 0), T = channel(last, 1);
    const meanPhi = sum(phi) / phi.length;
    const liquid = T.filter((_, i) => phi[i] < 0.1);
    const liquidT = sum(liquid) / Math.max(1, liquid.length);
    check('the ice fraction converges to 1/K plus the seed',
      Math.abs(meanPhi - target) < 0.01, `${meanPhi.toFixed(4)} vs ${target.toFixed(4)}`);
    check('the water warms to the melting point, not past it',
      liquidT > 0.98 && liquidT <= 1.0, `liquid T ${liquidT.toFixed(4)}`);
  }

  await p.page.evaluate(() => {
    window.__pa.setPassSize('flux', null);
    window.__pa.setPassSize('ice', null);
  });
  check('no console errors', p.consoleErrors.length === 0, p.consoleErrors.join('\n'));
} finally {
  await p.close();
}
