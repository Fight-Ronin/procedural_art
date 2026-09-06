/**
 * Splitting a large output into renderable tiles.
 *
 * Two reasons tiling exists, and only one of them is memory: a print-size
 * render also has to stay under the GPU driver's watchdog, which resets the
 * context if a single draw takes a couple of seconds. Tiles bound both.
 *
 * Correctness rests on one property, which test/export.test.ts pins: a tiled
 * render must be BIT-IDENTICAL to an untiled one. That holds because every
 * quantity an artwork sees is global — `mainImage` receives `gl_FragCoord +
 * uTileOrigin`, `artCoord` and `pxSize` divide by `uFullRes`, and the per-sample
 * RNG is seeded from the global pixel. Nothing in an artwork can observe the
 * tiling. Any seam is therefore a bug in viz, not a tolerance to widen.
 */

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cover `fullW` x `fullH` with tiles of at most `max` on a side.
 *
 * Two constraints shape this, and both exist to keep tiled output bit-identical
 * to untiled:
 *
 * 1. **Tile origins must be even.** `fwidth` and the other derivative functions
 *    are computed across 2x2 rasterizer quads aligned to the framebuffer. Give a
 *    tile an odd origin and its quad grid is offset from the untiled one, so
 *    pixels that shared a quad no longer do and the derivative — an
 *    antialiasing width, in practice — comes out slightly different. 001's
 *    contours showed this as a few thousand differing bytes on an odd split
 *    while every even split was exact. So `max` is rounded down to even.
 *
 * 2. **The layout is enumerated in GL space**, bottom-up, and converted to
 *    image space per tile. Laying out top-down instead would make an interior
 *    tile's GL origin `fullH - k*max`, which is odd whenever the output height
 *    is odd — undoing constraint 1 for half of all output sizes.
 *
 * The last row and column are short rather than overhanging: rendering past the
 * edge wastes work, and an overhanging tile would have to be cropped on
 * readback, which is where one-pixel seams come from.
 */
export function tiles(fullW: number, fullH: number, max: number): Tile[] {
  if (!Number.isInteger(fullW) || !Number.isInteger(fullH) || fullW < 1 || fullH < 1) {
    throw new Error(`bad output size ${fullW}x${fullH}`);
  }
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`bad tile size ${max}`);
  }
  const step = Math.max(2, max - (max % 2));
  const out: Tile[] = [];
  for (let glY = 0; glY < fullH; glY += step) {
    const h = Math.min(step, fullH - glY);
    for (let x = 0; x < fullW; x += step) {
      out.push({ x, y: fullH - glY - h, w: Math.min(step, fullW - x), h });
    }
  }
  return out;
}

/**
 * `uTileOrigin` for a tile, in GL's pixel space.
 *
 * Tiles are described top-left down, because that is what the assembled image,
 * the PNG and every human are. `gl_FragCoord` counts from the BOTTOM, so the
 * offset the shader adds has to be flipped: a tile occupying image rows
 * [y, y+h) sits at GL rows [fullH - y - h, fullH - y).
 *
 * Getting this wrong is invisible with a single tile — the flip is the identity
 * when the tile is the whole image — and scrambles vertical placement with any
 * other split, which is exactly how it first showed up here.
 */
export function glTileOrigin(tile: Tile, fullH: number): [number, number] {
  return [tile.x, fullH - tile.y - tile.h];
}

/**
 * Copy one tile's RGBA bytes into a full-size RGBA buffer.
 *
 * Both are top-left origin — `Renderer.readPixels` already flips the GL
 * bottom-up result — so this is a straight row-by-row blit.
 */
export function blitTile(
  /**
   * Typed either way: the assembly is index arithmetic on four samples per
   * pixel and does not care whether a sample is a byte or a 16-bit value. One
   * implementation means the deep export cannot develop its own off-by-one.
   */
  dest: Uint8Array | Uint16Array,
  fullW: number,
  fullH: number,
  tile: Tile,
  src: ArrayLike<number>,
): void {
  if (src.length !== tile.w * tile.h * 4) {
    throw new Error(
      `tile ${tile.x},${tile.y} is ${tile.w}x${tile.h} but got ${src.length} bytes ` +
        `(expected ${tile.w * tile.h * 4})`,
    );
  }
  if (tile.x + tile.w > fullW || tile.y + tile.h > fullH) {
    throw new Error(`tile ${tile.x},${tile.y} ${tile.w}x${tile.h} exceeds ${fullW}x${fullH}`);
  }
  const rowBytes = tile.w * 4;
  for (let row = 0; row < tile.h; row++) {
    const from = row * rowBytes;
    const to = ((tile.y + row) * fullW + tile.x) * 4;
    for (let i = 0; i < rowBytes; i++) dest[to + i] = src[from + i];
  }
}

/** Total samples a tile plan will evaluate. Useful for progress and budgeting. */
export function sampleCount(fullW: number, fullH: number, draws: number, spp: number): number {
  return fullW * fullH * draws * spp;
}
