/**
 * What a frame directory says about itself.
 *
 * `--resume` exists because a long render dies, and its whole value is that the
 * frames already on disk can be trusted. That trust has to be earned: if the
 * shader was edited, or the size or sample count changed, the frames on disk
 * are pictures of a different artwork and splicing new ones after them produces
 * a video that visibly jumps in the middle with nothing anywhere reporting a
 * problem. So a frame directory carries a manifest, and resuming into one that
 * disagrees is refused rather than guessed at.
 */
import { fingerprintDiff, type Fingerprint } from './fingerprint.ts';

export interface Manifest {
  piece: string;
  width: number;
  height: number;
  fps: number;
  spp: number;
  draws: number;
  start: number;
  /** Content hashes of basics/, the generated preamble, and the piece's shaders. */
  sources: Fingerprint;
}

/**
 * What in a manifest makes resuming unsafe, in words a person can act on.
 * Empty means the directory matches and its frames can be kept.
 */
export function manifestConflicts(want: Manifest, found: Manifest): string[] {
  const out: string[] = [];
  const key = (k: keyof Manifest, label: string) => {
    if (want[k] !== found[k]) out.push(`${label}: frames say ${found[k]}, this run wants ${want[k]}`);
  };
  key('piece', 'piece');
  key('width', 'width');
  key('height', 'height');
  key('spp', 'samples per draw');
  key('draws', 'draws');
  key('start', 'first frame');
  // Naming which side moved, not just that something did: "basics/ has changed"
  // is a sentence someone can act on, "the shaders have changed" is a shrug.
  out.push(...fingerprintDiff(found.sources, want.sources).map((s) => `${s} since those frames`));
  // fps deliberately not compared: it changes only how the frames are played
  // back, not what any of them contain.
  return out;
}
