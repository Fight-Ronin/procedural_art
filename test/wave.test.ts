/**
 * basics/field/wave.glsl — the gravity-wave surface.
 *
 * Everything here is an EXACT identity, because a sum of sinusoids has closed
 * form derivatives and there is no interpolant to approximate. That is a much
 * stronger position than `noise/hessian.glsl` could take, and it is worth
 * saying why the checks look so different: the fbm Hessian had to be caught by
 * convergence against a difference stencil, while this one is either right to
 * machine precision or wrong.
 *
 * The last probe is the one this module exists for. 001 proved that a composed
 * field pushed through a single moving offset can only translate; the escape is
 * DISPERSION, and the control is the same code with the dispersion switched
 * off, which must translate exactly.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('wave');

const N = 64;
const s = await launch(5243);

// Spread the samples over several wavelengths, off-lattice and off-axis.
const POINT = `
vec2 q = (pix + 0.5) / n;
vec2 sp = vec2(q.x * 5.1 - 2.4, q.y * 4.3 - 1.9);
float tt = q.x * 3.7 + q.y * 1.3;
`;

try {
  // --- one component, against the closed form written out by hand -----------
  //
  // A single wave is the whole model with the sum removed, so if the phase, the
  // sign of the time term, the amplitude-from-steepness conversion or the
  // outer product were wrong, this is where it shows. All four are things that
  // still produce a plausible moving surface when wrong.
  {
    const img = await runProbe(s, {
      includes: ['field/wave.glsl'],
      body: `${POINT}
float k0 = 3.0, steep = 0.25, speed = 1.4;
FlowWaveSurface w = flowWaveGravity(sp, tt, 1, k0, 1.37, steep, 0.0, 0.7, 0.0, speed, 0);

// The same component, written out. hash21s(vec2(0,1), 0) is the phase draw and
// hash21s(vec2(0,0), 0) the angle draw; with spread 0 the angle is exactly dir.
float psi = hash21s(vec2(0.0, 1.0), 0) * TAU;
vec2 d = vec2(cos(0.7), sin(0.7));
vec2 K = k0 * d;
float amp = steep / k0;
float ph = dot(K, sp) - speed * sqrt(k0) * tt + psi;

float eH = abs(w.h - amp * sin(ph));
float eG = length(w.grad - amp * cos(ph) * K);
mat2 hw = -amp * sin(ph) * mat2(K.x*K.x, K.x*K.y, K.x*K.y, K.y*K.y);
float eS = length(w.hess[0] - hw[0]) + length(w.hess[1] - hw[1]);

ok = vec3(step(eH, 1.0e-5), step(eG, 1.0e-4), step(eS, 1.0e-3));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['height', 'gradient', 'Hessian']);
    check('flowWaveGravity height matches the closed form for one component', c.failed[0] === 0, d);
    check('flowWaveGravity gradient matches the closed form', c.failed[1] === 0, d);
    check('flowWaveGravity Hessian matches the closed form', c.failed[2] === 0, d);
  }

  // --- one wave is a cylindrical lens ---------------------------------------
  //
  // outer(K, K) is rank one, so a single component's Hessian has determinant
  // exactly zero: it focuses across the crests and not at all along them. Two
  // consequences worth pinning, because both are visible in the artwork.
  //
  // det(I - a H) collapses to 1 - a tr(H), so a single wave has ONE focal
  // distance rather than two, and its caustic is a family of parallel lines
  // rather than a net. The net only appears when components with different
  // directions add, and that is the difference between swell and a confused
  // sea in the picture.
  //
  // THE CONTROL IS THE SECOND COMPONENT: with two waves the determinant must
  // stop being zero, or this check would pass just as well on a Hessian that
  // was accidentally always rank-deficient.
  {
    const img = await runProbe(s, {
      includes: ['field/wave.glsl', 'optics/lens.glsl'],
      body: `${POINT}
FlowWaveSurface one = flowWaveGravity(sp, tt, 1, 3.0, 1.37, 0.25, 0.0, 0.7, 0.9, 1.4, 0);
FlowWaveSurface two = flowWaveGravity(sp, tt, 5, 3.0, 1.37, 0.25, 0.0, 0.7, 0.9, 1.4, 0);

float scale1 = length(one.hess[0]) + length(one.hess[1]);
float d1 = abs(one.hess[0][0] * one.hess[1][1] - one.hess[0][1] * one.hess[1][0]);
float d2 = abs(two.hess[0][0] * two.hess[1][1] - two.hess[0][1] * two.hess[1][0]);
float scale2 = length(two.hess[0]) + length(two.hess[1]);

// One wave: determinant zero, so det(I - aH) is exactly the linear form.
float a = 0.11;
float lin = abs(optLensDetJ(one.hess, a) - (1.0 - a * (one.hess[0][0] + one.hess[1][1])));

ok = vec3(
    step(d1, 1.0e-4 * (1.0 + scale1 * scale1)),
    step(lin, 1.0e-5),
    step(1.0e-3 * (1.0 + scale2 * scale2), d2));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['one wave has zero determinant', 'so det J is linear in a', 'five waves do not (control)']);
    check('a single wave is a cylindrical lens — its Hessian is rank one', c.failed[0] === 0, d);
    check('so its det(I - aH) is exactly the linear form', c.failed[1] === 0, d);
    // A POPULATION BAR, and the shortfall is content. A sum of rank-one
    // matrices is generically full rank, but its determinant still passes
    // through zero on a curve: wherever one component's contribution momentarily
    // dominates the rest — near a crest of the longest wave, where its own
    // sin() is at an extremum and the others are not — the sum is nearly rank
    // one again. Measured at 3857/4088. Those points are not a defect; they are
    // where the caustic locally degenerates to parallel lines, which is visible
    // in the artwork as the net stretching out under a passing swell.
    check('and five waves are not rank one (control)',
      c.total - c.failed[2] >= c.total * 0.90, d);
  }

  // --- dispersion, and the pure pan it is not -------------------------------
  //
  // THE POINT OF THE WHOLE MODULE. A single component travels rigidly at its
  // phase speed c = omega/k, so evaluating it at time t equals evaluating it at
  // time 0 shifted by c t — exactly, to machine precision. That is the identity
  // that makes any NON-dispersive sum a pure pan, which is 001's finding
  // restated: one speed for everything means one offset for everything.
  //
  // With sqrt(k) dispersion the components have different speeds, so no single
  // offset carries the sum, and the surface deforms in place. Checked directly:
  // shift the five-wave field by the LONGEST component's phase speed — the best
  // case for a translation — and require it to disagree.
  {
    const img = await runProbe(s, {
      includes: ['field/wave.glsl'],
      body: `${POINT}
float k0 = 3.0, speed = 1.4, dt = 0.6;
vec2 d = vec2(cos(0.7), sin(0.7));
float c0 = flowWaveOmega(k0, speed) / k0;

// One component: rigid translation at its own phase speed, exactly.
FlowWaveSurface a0 = flowWaveGravity(sp, tt + dt, 1, k0, 1.37, 0.25, 0.0, 0.7, 0.0, speed, 0);
FlowWaveSurface a1 = flowWaveGravity(sp - d * c0 * dt, tt, 1, k0, 1.37, 0.25, 0.0, 0.7, 0.0, speed, 0);
float rigid = abs(a0.h - a1.h);

// Five components: the same shift cannot carry them, because they do not share
// a speed. Reported as a fraction of the field's own scale so the threshold is
// not a statement about amplitude.
FlowWaveSurface b0 = flowWaveGravity(sp, tt + dt, 5, k0, 1.37, 0.25, 0.0, 0.7, 0.0, speed, 0);
FlowWaveSurface b1 = flowWaveGravity(sp - d * c0 * dt, tt, 5, k0, 1.37, 0.25, 0.0, 0.7, 0.0, speed, 0);
float deform = abs(b0.h - b1.h);

// The third channel is the margin: deform must beat rigid by a wide factor,
// not merely exceed it. Without that, a field whose components happened to
// share a speed would still pass the second channel on float noise alone.
ok = vec3(step(rigid, 2.0e-5), step(2.0e-3, deform), step(rigid * 20.0, deform));
`,
    }, N);
    const c = countFailures(img);
    const d = describe(c, ['one wave translates exactly', 'five waves do not', 'and by a wide margin']);
    check('a single component is a rigid translation at its phase speed', c.failed[0] === 0, d);
    // Also a population bar, measured at 3917/4088. The five components drift
    // apart in phase almost everywhere, but at any instant there are points
    // where they happen to line up and the shifted field agrees anyway. A
    // deformation that is nonzero ALMOST everywhere is the correct claim; a
    // deformation that is nonzero everywhere would be a stronger claim than the
    // physics makes.
    check('a dispersive sum is not a translation at any component speed',
      c.total - c.failed[1] >= c.total * 0.92, d);
    check('and the gap is not marginal', c.total - c.failed[2] >= c.total * 0.98, d);
    note('this is 001\'s finding from the other side: one speed for everything is one '
      + 'offset for everything, so the only way to get deformation out of a sum is to '
      + 'give its parts different speeds — which the gravity-wave dispersion relation does '
      + 'for free');
  }

  check('no console errors while probing', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));
} finally {
  await s.close();
}
