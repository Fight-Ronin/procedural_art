/**
 * The display encode, on the Node side.
 *
 * Anything that averages, downsamples or compares rendered pixels has to undo
 * the sRGB encode first. Averaging encoded values is a well-known error and not
 * a small one: the encode is concave, so by Jensen's inequality a bimodal patch
 * of black-and-white pixels averages DARKER than a smooth patch carrying the
 * same light. A picture with sub-pixel contrast then reads as though its
 * brightness depends on resolution when only its sharpness does. Measured on
 * 007 — thin dark linework on pale paper, the worst case in this repo — that
 * artefact alone was 5.47/255 of an apparent 9.64/255 drift across a resolution
 * ladder, and it took a long time to stop being blamed on the artwork.
 *
 * This module exists because that arithmetic was written twice, in
 * `test/render.test.ts` and `tools/ladder.ts`, which is one more copy than a
 * fact this subtle should have.
 *
 * IT ALSO HAS TO RUN HERE RATHER THAN IN THE PAGE. The reduction used to be a
 * closure passed to `page.evaluate`, which Playwright serialises as source
 * text — and the TypeScript loader rewrites named arrow functions to reference
 * an `__name` helper that exists only in the module scope it came from. The
 * browser saw `ReferenceError: __name is not defined`, the whole render suite
 * aborted, and 54 checks silently stopped running while the summary still
 * reported a number. Pixel arithmetic has no reason to be in the browser at
 * all: the page renders, Node reduces.
 */

/** 8-bit encoded sample (0..255) to linear light (0..1). */
export function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light (0..1) back to the 0..255 scale, unrounded. */
export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

/**
 * Box-downsample a square RGBA image to `out` x `out`, averaging in linear
 * light and re-encoding, so the result is still in familiar 0..255 units.
 *
 * `out` MUST DIVIDE `size`, and the reason is grid alignment rather than
 * tidiness. Two renders of the same picture are compared by reducing both to
 * the same `out` grid, and that comparison is only meaningful if cell (i,j)
 * covers the same REGION OF THE PICTURE in each. With a remainder it does not:
 * 110px into 27 cells puts the first boundary at 4.55% of the image height,
 * 330px into 27 puts it at 3.94%, and the misalignment wanders across the grid
 * from there. Every cell then straddles a slightly different piece of the
 * image, which on a picture made of thin vertical columns reads as a per-cell
 * difference that looks exactly like resolution dependence and is not.
 *
 * 006 was the only caller with a non-dividing pair, and it carried the loosest
 * per-cell tolerance in the suite. Two thirds of that number turned out to be
 * this function rather than the artwork.
 *
 * Refusing is better than coping. Boxes of unequal size can be averaged
 * correctly by counting the pixels that land in each — but that fixes the
 * weighting while leaving the misalignment, so it would return a defensible
 * number that still answers the wrong question.
 */
export function reduceLinear(px: ArrayLike<number>, size: number, out: number): number[] {
  if (size % out !== 0) {
    throw new Error(
      `reduceLinear: ${out} cells do not divide ${size}px, so the cell grid would ` +
        'not line up with the same reduction of another size (see tone.ts)',
    );
  }
  const f = size / out;
  const acc = new Float64Array(out * out * 3);
  for (let y = 0; y < size; y++) {
    const oy = Math.floor(y / f);
    for (let x = 0; x < size; x++) {
      const cell = oy * out + Math.floor(x / f);
      for (let ch = 0; ch < 3; ch++) {
        acc[cell * 3 + ch] += srgbToLinear(px[(y * size + x) * 4 + ch]);
      }
    }
  }
  const per = f * f;
  return Array.from(acc, (v) => linearToSrgb(v / per));
}

/** Mean encoded level and mean linear level of an RGBA buffer, both on 0..255. */
export function levels(px: ArrayLike<number>): { encoded: number; linear: number } {
  let sum = 0;
  let lin = 0;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = px[i + c];
      sum += v;
      lin += srgbToLinear(v);
    }
  }
  const n3 = (px.length / 4) * 3;
  return { encoded: sum / n3, linear: (lin / n3) * 255 };
}
