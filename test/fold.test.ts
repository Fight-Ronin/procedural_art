/**
 * The wave fold, and the one character that makes it work.
 *
 * `nzFold3` is four lines, and four lines is exactly the size at which a
 * function gets read, believed and never checked. Two of its properties are
 * load-bearing for the pieces that use it and neither is visible in a picture:
 *
 *   THE DISPLACEMENT IS BOUNDED, and `nzFoldBound` says by how much. A volume
 *   piece sizes its bounding sphere from that number, so if the bound were
 *   wrong the outer filaments would be clipped against an invisible sphere —
 *   which reads as a strangely circular edge to the nebula, at a place in the
 *   image with nothing in it to blame.
 *
 *   THE SWIZZLE IS WHAT MAKES IT SWIRL. `cos(p.yzx * f)` displaces each axis by
 *   the OTHER two, which is a shear; `cos(p * f)` displaces each axis by itself,
 *   which is a separable ripple with no rotation in it anywhere. Dropping the
 *   three characters is the most plausible typo in the file, it compiles, it
 *   still produces wobbly output, and the filaments simply never appear.
 *
 * So the separable form is the control, and the property that separates them is
 * stated exactly rather than by eye: the CROSS PARTIAL d(q.x)/d(p.y) is
 * identically zero for the separable form and must not be for the real one.
 * That is the derivative-level statement of "the axes are coupled", and it is
 * the thing a picture cannot check.
 */
import { countFailures, describe, runProbe } from '../tools/probe.ts';
import { launch } from '../tools/session.ts';
import { check, section } from './harness.ts';

section('wave fold');

const N = 64; // 4096 sample points per probe

/** Points spread over several periods of the lowest octave, plus a z sweep. */
const SETUP = `
vec2 uv = (pix + 0.5) / n;
vec3 p = vec3(mix(-6.0, 6.0, uv.x), mix(-6.0, 6.0, uv.y), mix(-3.0, 3.0, fract(uv.x * 7.0)));
int oct = 6;
float lac = 1.0 / 0.7;
float gain = 0.7;
float amp = 1.0;
`;

const s = await launch(5227);
try {
  // --- the bound the callers rely on -----------------------------------------
  {
    const img = await runProbe(s, {
      includes: ['noise/fold.glsl'],
      body: `${SETUP}
vec3 q = nzFold3(p, oct, lac, gain, amp);
vec3 d = abs(q - p);
float bound = nzFoldBound(oct, gain, amp);

// The bound is a sum of absolute values, so it is attainable only if every
// octave peaks at once. It must HOLD everywhere...
float holds = step(max(max(d.x, d.y), d.z), bound + 1.0e-5);
// ...and it must not be loose to the point of uselessness: somewhere in 4096
// points the displacement should get within half of it, or a caller sizing a
// bounding sphere from it wastes most of the marching budget on empty space.
float tight = step(bound * 0.5, max(max(d.x, d.y), d.z));

ok = vec3(holds, tight, step(abs(nzFoldBound(oct, gain, 2.0) - 2.0 * bound), 1.0e-5));
`,
    }, N);
    const c = countFailures(img);
    check('the fold never moves a point further than nzFoldBound says',
      c.failed[0] === 0, describe(c, ['bound holds', 'bound is reached somewhere', 'bound is linear in amplitude']));
    // Not a failure on its own — the bound is a worst case — but if NO point in
    // 4096 gets near it the bound is describing a different function.
    check('the bound is reached somewhere, so it is not merely a large number',
      c.failed[1] < 4096, describe(c, ['bound holds', 'reached', 'linear in amplitude']));
    check('nzFoldBound scales linearly with amplitude',
      c.failed[2] === 0, describe(c, ['bound holds', 'reached', 'linear in amplitude']));
  }

  // --- the swizzle, against the separable control ----------------------------
  {
    const img = await runProbe(s, {
      includes: ['noise/fold.glsl'],
      decls: `
// The typo: the same loop with the swizzle removed. Each component is then
// displaced by a cosine of ITSELF, so the map is separable and its Jacobian is
// diagonal. It lives in decls because GLSL allows no declarations inside a
// function body, which is where a probe's body lands.
vec3 foldSeparable(vec3 p, int octaves, float lacunarity, float gain) {
    float f = 1.0;
    float a = 1.0;
    for (int i = 0; i < 12; ++i) {
        if (i >= octaves) break;
        p += cos(p * f) * a;
        f *= lacunarity;
        a *= gain;
    }
    return p;
}
`,
      body: `${SETUP}
float e = 1.0e-3;
vec3 dy = vec3(0.0, e, 0.0);

// d(q.x)/d(p.y): does moving along y move the warped x at all?
float realCross = (nzFold3(p + dy, oct, lac, gain, amp).x
                 - nzFold3(p - dy, oct, lac, gain, amp).x) / (2.0 * e);
float ctrlCross = (foldSeparable(p + dy, oct, lac, gain).x
                 - foldSeparable(p - dy, oct, lac, gain).x) / (2.0 * e);

// The separable form's cross partial is zero as an identity, not as a limit:
// q.x is a function of p.x alone, so the two evaluations differ in no bit that
// reaches x. Anything above float noise means the control is not what it claims.
ok = vec3(
    step(abs(ctrlCross), 1.0e-4),
    // and the real one must actually couple the axes, over most of the domain.
    // Not everywhere: the coupling passes through zero on surfaces, the same
    // way any derivative does.
    step(0.02, abs(realCross)),
    // both stay finite — a fold that blew up would also "couple" the axes
    step(abs(realCross), 1.0e3));
`,
    }, N);
    const c = countFailures(img);
    check('the separable form has NO axis coupling (control)',
      c.failed[0] === 0, describe(c, ['control cross partial is zero', 'real one is not', 'finite']));
    check('the real fold couples the axes almost everywhere',
      c.failed[1] < 4096 * 0.15 && c.failed[2] === 0,
      describe(c, ['control is zero', 'real couples', 'finite']));
  }

  // --- adding octaves converges ----------------------------------------------
  //
  // Octave i displaces by at most gain^i, so the tail past octave n is bounded
  // by gain^n/(1-gain). Without this a piece could not raise its octave count
  // for a print without changing the picture's large-scale shape.
  {
    const img = await runProbe(s, {
      includes: ['noise/fold.glsl'],
      body: `${SETUP}
vec3 q6 = nzFold3(p, 6, lac, gain, amp);
vec3 q9 = nzFold3(p, 9, lac, gain, amp);
vec3 d = abs(q9 - q6);
float tail = pow(gain, 6.0) / (1.0 - gain);

// The tail bound holds...
float within = step(max(max(d.x, d.y), d.z), tail + 1.0e-5);
// ...and the extra octaves are not simply doing nothing, which would make the
// bound true and the convergence claim vacuous.
float moved = step(1.0e-4, max(max(d.x, d.y), d.z));
// One octave is the identity plus a single cosine: check the base case exactly.
vec3 one = nzFold3(p, 1, lac, gain, amp);
float base = step(length(one - p - cos(p.yzx)), 1.0e-5);

ok = vec3(within, moved, base);
`,
    }, N);
    const c = countFailures(img);
    check('extra octaves change the result by less than the tail bound',
      c.failed[0] === 0, describe(c, ['within the tail bound', 'extra octaves do something', 'one octave is one cosine']));
    check('one octave is exactly the identity plus one cosine',
      c.failed[2] === 0 && c.failed[1] === 0,
      describe(c, ['within tail', 'octaves do something', 'base case']));
  }

  // --- the tonemap that arrived with it --------------------------------------
  //
  // `colTonemapTanh` was added for this family of pieces. Its two claims are the
  // reason it exists beside ACES rather than instead of it: it never clips, and
  // it leaves the bottom of the range alone so that black stays black.
  {
    const img = await runProbe(s, {
      includes: ['color/tonemap.glsl'],
      body: `
vec2 uv = (pix + 0.5) / n;
float x = exp2(mix(-12.0, 6.0, uv.x));   // 0.0002 .. 64, well past where it saturates
vec3 v = vec3(x, x * 0.5, x * 2.0);
vec3 m = colTonemapTanh(v);

// Never leaves [0,1) however large the input, and never returns NaN — the
// naive tanh(x) of a large float is fine, but an exp-based expansion is not.
float bounded = step(max(max(m.r, m.g), m.b), 1.0);
float finite = (m.r == m.r && m.g == m.g && m.b == m.b) ? 1.0 : 0.0;
// Slope 1 at the origin: small values pass through essentially untouched, which
// is the property ACES does not have and the reason black stays black.
float small = x < 0.01 ? step(abs(m.r - x), x * 0.01 + 1.0e-7) : 1.0;

ok = vec3(bounded, finite, small);
`,
    }, N);
    const c = countFailures(img);
    check('colTonemapTanh never clips and never returns NaN',
      c.failed[0] === 0 && c.failed[1] === 0,
      describe(c, ['bounded by 1', 'finite', 'unity slope near 0']));
    check('colTonemapTanh passes small values through untouched (black stays black)',
      c.failed[2] === 0, describe(c, ['bounded', 'finite', 'unity slope near 0']));
  }
} finally {
  await s.close();
}
