/**
 * Frame sequence rendering: the same tile machinery as a still, run forward in
 * time.
 *
 * The whole design rests on one invariant, and it is worth stating plainly
 * because everything else follows from it:
 *
 *   Frame N of a sequence is bit-identical to a still rendered at frame N.
 *
 * That is not free. A sequence STEPS — seek once to the first frame, then
 * advance one frame at a time, because re-deriving a stateful piece from the
 * seed for every frame would make an 1800-frame render quadratic. A still
 * SEEKS — it re-derives frame N from the seed, because it has nowhere else to
 * start from. Two different code paths reaching the same pixels is exactly the
 * kind of thing that quietly stops being true, so `test/sequence.test.ts`
 * compares them byte for byte rather than trusting the argument above.
 *
 * The consequence for the caller: never step and seek in the same run. Seek
 * once at the start, then only advance.
 */
import type { Page } from 'playwright-core';
import { renderFrame, type StillOptions } from './export.ts';
import type { Image } from './png.ts';

export interface SequenceOptions extends Omit<StillOptions, 'frame'> {
  /** First frame of the sequence. For a stateful piece, N simulation steps in. */
  start: number;
  /** How many frames to render, starting at `start`. */
  count: number;
  /**
   * Return false to step past a frame without rendering it — the resume path.
   * The simulation is still advanced through it, because it has to be: a
   * simulation cannot skip time, only rendering can.
   */
  shouldRender?: (frame: number, index: number) => boolean;
}

/** Called with each rendered frame, in order. Awaited, so a slow sink throttles. */
export type FrameSink = (frame: number, index: number, image: Image) => void | Promise<void>;

/**
 * Render `count` frames from `start`, handing each to `sink` as it completes.
 *
 * Frames are streamed rather than collected: a 1080p frame is 8MB of RGBA, so a
 * few hundred of them held in memory is how a render dies at frame 400 with
 * nothing to show for the four hours before it.
 */
export async function renderSequence(
  page: Page,
  opts: SequenceOptions,
  sink: FrameSink,
): Promise<void> {
  if (opts.count < 0) throw new Error(`count must not be negative (got ${opts.count})`);
  if (opts.start < 0) throw new Error(`start must not be negative (got ${opts.start})`);
  if (opts.count === 0) return;

  // The only seek in the whole run.
  await page.evaluate(
    ({ w, h, f }: { w: number; h: number; f: number }) => window.__pa.seekTo(w, h, f),
    { w: opts.width, h: opts.height, f: opts.start },
  );

  for (let i = 0; i < opts.count; i++) {
    const frame = opts.start + i;
    if (opts.shouldRender?.(frame, i) !== false) {
      const image = await renderFrame(page, { ...opts, frame });
      await sink(frame, i, image);
    }
    // Not after the last frame: leaving the piece sitting on the frame it just
    // rendered means the state on exit says what was produced, which a test can
    // check and a human can look at.
    if (i + 1 < opts.count) await page.evaluate(() => window.__pa.advanceFrame(1));
  }
}

/**
 * Frame count for a piece's declared `video` block.
 *
 * Rounded, not truncated: at 23.976fps a declared 10 seconds is 239.76 frames,
 * and 239 would be a sequence that is quietly short of what the artwork says it
 * is.
 */
export function frameCount(seconds: number, fps: number): number {
  return Math.max(1, Math.round(seconds * fps));
}
