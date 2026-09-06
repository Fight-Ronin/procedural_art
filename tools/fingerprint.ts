/**
 * Content hashes of the three things that decide what a piece looks like.
 *
 * `meta.json` used to carry a `basicsCommit` field that was `null` in every
 * piece — a declared provenance record that recorded nothing, which is the same
 * failure the reference images had before they existed: documentation of a
 * mechanism that is not there. It is replaced by this, because a hash the tool
 * computes cannot be forgotten and a commit id typed by hand always is.
 *
 * Three hashes rather than one, because the useful question when a reference
 * image goes red is not "did anything change" — the red already said that — but
 * WHICH SIDE changed:
 *
 *   basics  the shared GLSL library. The usual suspect, and the reason the
 *           reference net exists at all.
 *   build   visualization/build/ — the include resolver and the generated
 *           preamble. These emit GLSL too: the sampling loop, artCoord, the
 *           RNG, the sRGB encode. A change here alters every piece at once
 *           while both basics/ and the artwork are untouched, which is the
 *           case that is hardest to guess at from the picture.
 *   piece   the artwork's own shaders.
 *
 * All three unchanged and the image still different means the renderer moved,
 * or something in viz outside build/ that has no business affecting pixels.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface Fingerprint {
  basics: string;
  build: string;
  piece: string;
}

/** Every file under `dir`, recursively, sorted — so the hash is order-stable. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Hash a directory's contents. Paths go into the hash alongside the bytes, so
 * renaming a file changes the result — a rename is a change.
 */
function hashTree(root: string, dir: string, keep: (f: string) => boolean): string {
  const h = createHash('sha256');
  for (const f of walk(path.join(root, dir)).filter(keep)) {
    h.update(path.relative(root, f).split(path.sep).join('/'));
    h.update(readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

const isGlsl = (f: string) => f.endsWith('.glsl') || f.endsWith('.frag') || f.endsWith('.vert');

/**
 * `pieceDir` is repo-relative, e.g. `artwork/003-coalesce`.
 *
 * basics/ is hashed in full rather than following the piece's actual include
 * graph: the graph is resolved in the browser, and reproducing the resolver here
 * to skip a few dozen small files would be a second implementation of the one
 * thing in this repo that most needs exactly one. Over-invalidating costs a
 * needless re-render; under-invalidating costs a wrong answer about what moved.
 */
export function fingerprint(root: string, pieceDir: string): Fingerprint {
  return {
    basics: hashTree(root, 'basics', isGlsl),
    build: hashTree(root, path.join('visualization', 'build'), (f) => f.endsWith('.ts')),
    piece: hashTree(root, pieceDir, isGlsl),
  };
}

/**
 * What moved between two fingerprints, in words a person can act on. Empty
 * means all three sides are identical.
 */
export function fingerprintDiff(before: Fingerprint, after: Fingerprint): string[] {
  const labels: [keyof Fingerprint, string][] = [
    ['basics', 'basics/ has changed'],
    ['build', "visualization/build/ has changed (the preamble or the include resolver)"],
    ['piece', "the piece's own shaders have changed"],
  ];
  return labels.filter(([k]) => before[k] !== after[k]).map(([, s]) => s);
}
