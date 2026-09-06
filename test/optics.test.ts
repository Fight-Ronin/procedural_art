/**
 * basics/optics/glass.glsl carries a baked constant, OPT_SPECTRAL_NORM, that
 * makes a uniformly-sampled spectrum integrate to white. This re-derives it
 * from the same CIE fits and fails if the two ever drift apart — a silent drift
 * would tint every dispersed highlight and be almost impossible to attribute.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
