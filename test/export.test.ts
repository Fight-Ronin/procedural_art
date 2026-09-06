/**
 * Tiled export.
 *
 * The load-bearing claim is that a tiled render is BIT-IDENTICAL to an untiled
 * one — not "close", not "seamless to the eye". Everything an artwork can
 * observe is global (fragCoord carries uTileOrigin, artCoord and pxSize divide
 * by uFullRes, the RNG is seeded from the global pixel), so nothing about the
 * tiling is visible to it. That makes exact equality the right assertion, and
 * any difference a bug rather than a tolerance to widen.
 *
 * The uneven split matters most: equal tiles hide off-by-ones that a short last
 * row and column expose immediately.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { blitTile, glTileOrigin, sampleCount, tiles } from '../visualization/render/tile.ts';
import { renderStill, renderStillAt } from '../tools/export.ts';
import { decodePng, encodePng, encodePng16, type Image16 } from '../tools/png.ts';
import { launch } from '../tools/session.ts';
import { check, note, section, throwsWith } from './harness.ts';
import { ROOT } from './paths.ts';

section('tile plan');

{
  const cases: [number, number, number][] = [
    [256, 256, 256], [256, 256, 64], [100, 100, 40], [1, 1, 64],
    [1000, 700, 256], [7, 13, 3], [4000, 5000, 1024],
  ];
  let allExact = true;
  let allInside = true;
  let noOverlap = true;
  for (const [w, h, max] of cases) {
    const plan = tiles(w, h, max);
    const cover = new Uint8Array(w * h);
    for (const t of plan) {
      if (t.x + t.w > w || t.y + t.h > h || t.w < 1 || t.h < 1) allInside = false;
      for (let y = t.y; y < t.y + t.h; y++) {
        for (let x = t.x; x < t.x + t.w; x++) {
          if (cover[y * w + x]++) noOverlap = false;
        }
      }
    }
    if (cover.some((c) => c !== 1)) allExact = false;
  }
  check('tile plans cover every pixel exactly once', allExact && noOverlap);
  check('tiles stay inside the output', allInside);
  check('an uneven split ends with a short tile',
    JSON.stringify([...new Set(tiles(100, 100, 40).map((t) => t.w))].sort((a, b) => b - a))
      === '[40,20]');

  // Constraint 1: derivative quads are 2x2 and framebuffer-aligned, so every
  // tile origin in GL space has to be even or fwidth changes under tiling.
  let originsEven = true;
  for (const [w, h, max] of [[180, 180, 77], [301, 199, 63], [500, 320, 128], [7, 13, 3]] as const) {
    for (const t of tiles(w, h, max)) {
      const [ox, oy] = glTileOrigin(t, h);
      if (ox % 2 !== 0 || oy % 2 !== 0) originsEven = false;
    }
  }
  check('every tile origin is even in GL space, for odd sizes too', originsEven);
  check('an odd tile size is rounded down to even',
    tiles(200, 200, 77).every((t) => t.w === 76 || t.w === 200 - 2 * 76));
  check('a tile larger than the output yields one tile', tiles(300, 200, 1024).length === 1);
  check('sampleCount multiplies out',
    sampleCount(100, 50, 4, 8) === 100 * 50 * 32);
  // The flip between image space and GL space. Identity for a full-height tile,
  // which is why a single-tile export can pass while every split is scrambled.
  check('gl origin flips a top row to the top of GL space',
    JSON.stringify(glTileOrigin({ x: 0, y: 0, w: 64, h: 64 }, 192)) === '[0,128]');
  check('gl origin leaves a bottom row at zero',
    JSON.stringify(glTileOrigin({ x: 32, y: 128, w: 64, h: 64 }, 192)) === '[32,0]');
  check('gl origin is the identity for a full-height tile',
    JSON.stringify(glTileOrigin({ x: 0, y: 0, w: 90, h: 90 }, 90)) === '[0,0]');
  check('gl origin handles a short last row',
    JSON.stringify(glTileOrigin({ x: 0, y: 80, w: 40, h: 20 }, 100)) === '[0,0]');

  throwsWith('rejects a zero tile size', Error, () => tiles(10, 10, 0));
  throwsWith('rejects a non-integer output', Error, () => tiles(10.5, 10, 4));
}

section('tile assembly');

{
  // A pattern where every pixel is distinguishable, so a misplaced row shows.
  const W = 37;
  const H = 23;
  const expected = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      expected[i] = x * 7 % 256;
      expected[i + 1] = y * 11 % 256;
      expected[i + 2] = (x * y) % 256;
      expected[i + 3] = 255;
    }
  }
  const got = new Uint8Array(W * H * 4);
  for (const t of tiles(W, H, 8)) {
    const src = new Uint8Array(t.w * t.h * 4);
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        src.set(
          expected.subarray(((t.y + y) * W + t.x + x) * 4, ((t.y + y) * W + t.x + x) * 4 + 4),
          (y * t.w + x) * 4,
        );
      }
    }
    blitTile(got, W, H, t, src);
  }
  check('assembling uneven tiles reproduces the source exactly',
    Buffer.compare(Buffer.from(got), Buffer.from(expected)) === 0);
  throwsWith('rejects a wrong-sized tile buffer', Error, () =>
    blitTile(got, W, H, { x: 0, y: 0, w: 4, h: 4 }, new Uint8Array(3)));
  throwsWith('rejects a tile outside the output', Error, () =>
    blitTile(got, W, H, { x: W - 2, y: 0, w: 8, h: 4 }, new Uint8Array(8 * 4 * 4)));
}

section('png');

{
  const W = 61;
  const H = 43;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 3)) & 0xff;
  const png = encodePng({ width: W, height: H, data });
  const back = decodePng(png);
  check('png round-trips size', back.width === W && back.height === H);
  check('png round-trips every byte',
    Buffer.compare(Buffer.from(back.data), Buffer.from(data)) === 0);
  check('png starts with the signature', png[0] === 0x89 && png.toString('ascii', 1, 4) === 'PNG');

  const corrupt = Buffer.from(png);
  corrupt[corrupt.length - 20] ^= 0xff; // inside IDAT
  throwsWith('a corrupted chunk fails its CRC', Error, () => decodePng(corrupt));
  throwsWith('rejects a mismatched buffer length', Error, () =>
    encodePng({ width: W, height: H, data: new Uint8Array(10) }));
}

section('export');

interface ExportCase {
  id: string;
  size: number;
  /** Tile sizes to compare against the untiled reference; include an uneven one. */
  tileSizes: number[];
  draws: number;
  spp: number;
  /** Frame to export. For a stateful piece, that is its simulation step count. */
  frame: number;
}

const CASES: ExportCase[] = [
  // Tile sizes deliberately include ones that do not divide the output, and odd
  // ones that get rounded down — the short last row and column are where
  // off-by-ones live. 001 is the sensitive case: it is the only piece using
  // fwidth, so it is the one that detects quad misalignment.
  { id: '001', size: 180, tileSizes: [180, 60, 77, 46], draws: 2, spp: 2, frame: 0 },
  { id: '002', size: 108, tileSizes: [108, 36, 41], draws: 2, spp: 2, frame: 0 },
  { id: '003', size: 144, tileSizes: [144, 48, 53], draws: 2, spp: 2, frame: 8 },
  // 004 traces a streamline per pixel entirely in art space, so nothing it does
  // can observe the framebuffer — but that is exactly the sort of claim the
  // byte comparison exists to check rather than accept.
  { id: '004', size: 132, tileSizes: [132, 44, 47], draws: 2, spp: 2, frame: 0 },
  // 005 marches: the tolerance is derived from the pixel footprint, so a tile
  // that got uFullRes wrong would resolve the surface at a different precision
  // and differ from the untiled render everywhere, not just at the seams.
  { id: '005', size: 100, tileSizes: [100, 34, 37], draws: 2, spp: 2, frame: 0 },
];

const only = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
const ACTIVE = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;

const s = await launch(5201);

for (const c of ACTIVE) {
  await s.open(`?p=${c.id}`);
  const err = await s.page.evaluate(() => window.__pa.error);
  if (!check(`${c.id} compiles`, !err, err ?? '')) continue;

  // The untiled reference comes from the ordinary render path, which seeks to
  // the frame itself. Each tiled run below seeks again, so this doubles as a
  // check that the seek is reproducible: if it were not, every tiled export of
  // a stateful piece would differ from the still, and from the last one.
  const reference = Buffer.from(
    await s.page.evaluate(
      ({ n, d, spp, f }: { n: number; d: number; spp: number; f: number }) =>
        window.__pa.accumulateAt(n, n, f, d, spp),
      { n: c.size, d: c.draws, spp: c.spp, f: c.frame },
    ),
  );
  const spread = reference.reduce((m, v) => Math.max(m, v), 0)
    - reference.reduce((m, v) => Math.min(m, v), 255);
  check(`${c.id} reference frame has content`, spread > 30, `channel spread ${spread}`);

  for (const tileSize of c.tileSizes) {
    const t0 = Date.now();
    const img = await renderStill(s.page, {
      width: c.size, height: c.size, tile: tileSize,
      draws: c.draws, spp: c.spp, frame: c.frame,
    });
    const plan = tiles(c.size, c.size, tileSize);
    const uneven = plan.some((t) => t.w !== tileSize || t.h !== tileSize);
    const got = Buffer.from(img.data);
    let diff = 0;
    let worst = 0;
    for (let i = 0; i < got.length; i++) {
      const d = Math.abs(got[i] - reference[i]);
      if (d) diff++;
      if (d > worst) worst = d;
    }
    check(
      `${c.id} ${plan.length} tiles of ${tileSize}px${uneven ? ' (uneven)' : ''} ` +
        'is bit-identical to untiled',
      diff === 0,
      diff === 0
        ? `${((Date.now() - t0) / 1000).toFixed(1)}s`
        : `${diff} bytes differ, worst ${worst}`,
    );
  }
}

// One real file, end to end, at a size no single draw would survive on a GPU
// with a watchdog.
{
  const c = ACTIVE[0];
  if (c) {
    await s.open(`?p=${c.id}`);
    const img = await renderStill(s.page, {
      width: 500, height: 320, tile: 128, draws: 2, spp: 2, frame: c.frame,
    });
    const out = path.join(ROOT, 'artwork', 'out');
    mkdirSync(out, { recursive: true });
    const file = path.join(out, 'export-check.png');
    writeFileSync(file, encodePng(img));
    const back = decodePng(readFileSync(file));
    check('a written png decodes to the rendered pixels',
      back.width === 500 && back.height === 320 &&
        Buffer.compare(Buffer.from(back.data), Buffer.from(img.data)) === 0);
    note(`non-square output, ${tiles(500, 320, 128).length} tiles, ${file.split('/').slice(-2).join('/')}`);
  }
}

// --- the deep path -----------------------------------------------------------
//
// 16-bit output resolves into a float target instead of letting the 8-bit
// canvas quantise, so it is a genuinely different route to the same picture.
// Three things have to hold, and one of them would otherwise fail silently: a
// deep path that quietly fell back to 8 bits still produces a valid,
// correct-looking 16-bit file.
{
  const c = ACTIVE.find((x) => x.id === '001') ?? ACTIVE[0];
  if (c) {
    await s.open(`?p=${c.id}`);
    const opts = { width: c.size, height: c.size, draws: c.draws, spp: c.spp, frame: c.frame };

    const untiled = await renderStillAt(s.page, { ...opts, tile: c.size, depth: 16 });
    const tiled = await renderStillAt(s.page, { ...opts, tile: 44, depth: 16 });
    const a = untiled.data as Uint16Array;
    const b = tiled.data as Uint16Array;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    check(`${c.id} a 16-bit tiled render is bit-identical to untiled`, diff === 0,
      diff === 0 ? `${tiles(c.size, c.size, 44).length} tiles` : `${diff} samples differ`);

    // The check that catches a silent fallback: 8-bit data promoted into a
    // 16-bit container can hold at most 256 distinct values per channel.
    const levels = new Set<number>();
    for (let i = 0; i < a.length; i += 4) levels.add(a[i]);
    check(`${c.id} 16-bit output carries more than 8 bits could`, levels.size > 256,
      `${levels.size} distinct red levels (the 8-bit ceiling is 256)`);

    // And it must be the SAME picture, not merely a deeper one. Not exact: the
    // two paths dither at their own depths, so they differ by about one step of
    // the shallower one.
    const shallow = await renderStillAt(s.page, { ...opts, tile: c.size, depth: 8 });
    const eight = shallow.data as Uint8Array;
    let worst = 0;
    for (let i = 0; i < eight.length; i++) {
      worst = Math.max(worst, Math.abs(Math.round((a[i] / 65535) * 255) - eight[i]));
    }
    check(`${c.id} the 16-bit and 8-bit renders are the same picture`, worst <= 2,
      `worst channel difference ${worst}/255 after reducing 16-bit to 8`);

    // A deliberately independent read of the file: inflate and take big-endian
    // samples by hand rather than through this repo's own decoder, which reads
    // only 8 bits and would in any case be agreeing with itself.
    const png = encodePng16(untiled as Image16);
    const ihdr = png.subarray(16, 16 + 13);
    check('the 16-bit png declares 16-bit RGBA at the right size',
      ihdr.readUInt32BE(0) === c.size && ihdr.readUInt32BE(4) === c.size &&
        ihdr[8] === 16 && ihdr[9] === 6,
      `${ihdr.readUInt32BE(0)}x${ihdr.readUInt32BE(4)} depth ${ihdr[8]} colour type ${ihdr[9]}`);

    let at = 8;
    let idat = Buffer.alloc(0);
    while (at < png.length) {
      const len = png.readUInt32BE(at);
      if (png.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') {
        idat = Buffer.concat([idat, png.subarray(at + 8, at + 8 + len)]);
      }
      at += 12 + len;
    }
    const raw = inflateSync(idat);
    const stride = c.size * 8;
    let bad = 0;
    outer: for (let y = 0; y < c.size; y++) {
      const row = y * (stride + 1);
      if (raw[row] !== 0) { bad = 1; break; }
      for (let i = 0; i < c.size * 4; i++) {
        const v = (raw[row + 1 + i * 2] << 8) | raw[row + 2 + i * 2];
        if (v !== a[y * c.size * 4 + i]) { bad = 2; break outer; }
      }
    }
    check('the 16-bit png round-trips through an independent decode', bad === 0,
      bad === 1 ? 'unexpected row filter' : bad === 2 ? 'sample mismatch' : 'big-endian, filter 0');
  }
}

check('no console errors during export', s.consoleErrors.length === 0,
  s.consoleErrors.join('\n'));

await s.close();
