/**
 * Committed gallery thumbnails.
 *
 *   npm run thumbs         # every piece
 *   npm run thumbs -- 003  # one piece
 *
 * `artwork/*​/out/` is gitignored, so posters and exports do not travel with the
 * repo — which is right for a 4000px print and wrong for a gallery, whose whole
 * job is to show something the moment the repo is cloned. `thumb.png` is
 * therefore committed, and kept small enough that committing it stays
 * defensible as the number of pieces grows.
 *
 * The frame and seed come from the piece's own `poster` block, so the thumbnail
 * is the moment the artwork nominates, not an arbitrary frame 0 — which for a
 * reaction-diffusion is undifferentiated noise.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderStill } from './export.ts';
import { encodePng } from './png.ts';
import { usePreset } from './preset.ts';
import { pieceRefs } from './ref.ts';
import { launch, ROOT } from './session.ts';

/**
 * Short side, in pixels. Large enough to look like the artwork on a retina
 * screen at card size; small enough that fifty of them in git history is a few
 * megabytes rather than a few hundred.
 */
const SHORT = 400;
const DRAWS = 8;
const SPP = 4;

interface Meta {
  poster?: { frame?: number; seed?: number };
  still?: { width?: number; height?: number };
  /**
   * Per-piece thumbnail cost. A volumetric raymarcher can want fifteen minutes
   * for the default thirty-two samples where a field piece wants eight seconds,
   * and a gallery image is not worth either extreme — so the piece declares what
   * it needs rather than every piece paying the slowest one's price.
   */
  thumb?: { draws?: number; spp?: number };
  preset?: string;
  presets?: { name: string; values: Record<string, unknown> }[];
}

const argv = process.argv.slice(2);
// A flag's value is not a piece id, even when it looks like one.
const ids = argv.filter((a, i) => /^\d{3}$/.test(a) && !(i > 0 && argv[i - 1].startsWith('--')));
const force = argv.includes('--force');
const presetFlag = argv.includes('--preset') ? argv[argv.indexOf('--preset') + 1] : undefined;
const pieces = pieceRefs(ids.length ? ids : undefined);
if (pieces.length === 0) {
  console.error(`no pieces match ${ids.join(', ')}`);
  process.exit(2);
}
// One name cannot mean anything sensible across several pieces: presets are
// per-piece, so `--preset dusk` over all eight would either refuse on the first
// piece that lacks it or, worse, mean a different look in each one that has it.
// Without the flag every piece uses whatever its own meta.json declares.
if (presetFlag !== undefined && pieces.length !== 1) {
  console.error(
    `--preset names one piece's look, but ${pieces.length} pieces are selected;\n` +
      '  pass a piece id too, or set "preset" in each meta.json',
  );
  process.exit(2);
}

const session = await launch(5217);
try {
  for (const p of pieces) {
    const out = path.join(ROOT, p.dir, 'thumb.png');
    if (existsSync(out) && !force) {
      console.log(`  ${p.id}  thumb.png exists (--force to replace)`);
      continue;
    }
    const meta = JSON.parse(readFileSync(path.join(ROOT, p.dir, 'meta.json'), 'utf8')) as Meta;

    // The artwork's own aspect, not a square: a 4:5 piece cropped to a square
    // tile is a different composition, and the gallery can lay out mixed
    // aspects perfectly well.
    const aspect = (meta.still?.width ?? 1) / (meta.still?.height ?? 1);
    const width = aspect >= 1 ? Math.round(SHORT * aspect) : SHORT;
    const height = aspect >= 1 ? SHORT : Math.round(SHORT / aspect);
    const frame = meta.poster?.frame ?? 0;
    const draws = meta.thumb?.draws ?? DRAWS;
    const spp = meta.thumb?.spp ?? SPP;

    await session.open(`?p=${p.id}`);
    const err = await session.page.evaluate(() => window.__pa.error);
    if (err) {
      console.error(`  ${p.id}  shader failed to compile\n${err}`);
      process.exitCode = 1;
      continue;
    }
    await session.page.evaluate((s: number) => window.__pa.setSeed(s), meta.poster?.seed ?? 0);
    const preset = await usePreset(session.page, meta, presetFlag, `thumbs ${p.id}`);

    const began = Date.now();
    const image = await renderStill(session.page, {
      width, height, tile: 512, draws, spp, frame,
    });
    writeFileSync(out, encodePng(image));
    console.log(
      `  ${p.id}  ${width}x${height}, frame ${frame}, ${draws * spp} samples` +
        `${preset ? `, preset "${preset}"` : ''}  ->  ` +
        `${path.relative(ROOT, out)}  (${((Date.now() - began) / 1000).toFixed(1)}s)`,
    );
  }

  if (session.consoleErrors.length) {
    console.error(`console errors:\n  ${session.consoleErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await session.close();
}
