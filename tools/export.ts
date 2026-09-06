/**
 * Still export: run the tile plan and assemble one image.
 *
 * Node owns the loop rather than the page, for two reasons. Tiles come back
 * one at a time, so browser memory stays at one tile rather than a whole
 * 8000px frame; and the loop is then plain testable code that the export suite
 * drives directly instead of through a CLI.
 */
import type { Page } from 'playwright-core';
import { blitTile, tiles, type Tile } from '../visualization/render/tile.ts';
import type { Image, Image16 } from './png.ts';

export interface StillOptions {
  width: number;
  height: number;
  /** Maximum tile edge. Smaller keeps each draw well inside the driver watchdog. */
  tile: number;
  /** Accumulation draws per tile; each contributes `spp` samples. */
  draws: number;
  spp: number;
  frame: number;
  /**
   * Channel depth of the returned image. 16 resolves into a float target and
   * quantises there instead of letting the 8-bit canvas do it — see
   * Renderer.readDeep. The tile plan, the seeking and the bit-identity
   * guarantee are identical either way.
   */
  depth?: 8 | 16;
  onProgress?: (done: number, total: number, tile: Tile) => void;
}

/**
 * Render one already-positioned frame by tiles. The caller is responsible for
 * having put the piece at the right frame — for a stateful piece that is an
 * O(frame) seek, and doing it here would repeat it for every frame of a
 * sequence.
 */
export async function renderFrame(page: Page, opts: StillOptions): Promise<Image> {
  const img = await renderFrameAt(page, { ...opts, depth: 8 });
  return img as Image;
}

/**
 * Render one already-positioned frame at the requested depth.
 *
 * One function for both depths on purpose: the tile plan, the even origins, the
 * GL-space enumeration and the assembly are the property being protected, and
 * two copies of them would be two chances for the deep path to drift out of
 * agreement with the shallow one.
 */
export async function renderFrameAt(
  page: Page,
  opts: StillOptions,
): Promise<Image | Image16> {
  const { width, height } = opts;
  const deep = opts.depth === 16;
  const plan = tiles(width, height, opts.tile);

  const data = deep
    ? new Uint16Array(width * height * 4)
    : new Uint8Array(width * height * 4);
  for (let i = 0; i < plan.length; i++) {
    const tile = plan[i];
    const samples = await page.evaluate(
      ({
        w,
        h,
        t,
        frame,
        draws,
        spp,
        d,
      }: {
        w: number;
        h: number;
        t: Tile;
        frame: number;
        draws: number;
        spp: number;
        d: boolean;
      }) => (d
        ? window.__pa.renderTile16(w, h, t, frame, draws, spp)
        : window.__pa.renderTile(w, h, t, frame, draws, spp)),
      { w: width, h: height, t: tile, frame: opts.frame, draws: opts.draws, spp: opts.spp,
        d: deep },
    );
    blitTile(data, width, height, tile, samples);
    opts.onProgress?.(i + 1, plan.length, tile);
  }

  return { width, height, data } as Image | Image16;
}

/** Seek to the frame, then render it. The single-image entry point. */
export async function renderStill(page: Page, opts: StillOptions): Promise<Image> {
  await seek(page, opts);
  return renderFrame(page, opts);
}

/** Seek and render at the requested depth. */
export async function renderStillAt(
  page: Page,
  opts: StillOptions,
): Promise<Image | Image16> {
  await seek(page, opts);
  return renderFrameAt(page, opts);
}

function seek(page: Page, opts: StillOptions): Promise<void> {
  return page.evaluate(
    ({ w, h, frame }: { w: number; h: number; frame: number }) =>
      window.__pa.seekTo(w, h, frame),
    { w: opts.width, h: opts.height, frame: opts.frame },
  );
}
