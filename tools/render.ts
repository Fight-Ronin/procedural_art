/**
 * Still-image export CLI.
 *
 *   npm run render -- 003 --width 3000 --height 3000 --spp 8 --draws 8
 *
 * Defaults come from the piece's meta.json `still` block, so the declared
 * intent of the artwork is what you get when you pass nothing.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderStillAt } from './export.ts';
import { encodePng, encodePng16, type Image, type Image16 } from './png.ts';
import { chosenPreset, usePreset } from './preset.ts';
import { launch, ROOT } from './session.ts';

interface Args {
  [k: string]: string | undefined;
}

function parseArgs(argv: string[]): { piece: string; flags: Args } {
  const positional: string[] = [];
  const flags: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error('usage: render <piece-id> [--width N] [--height N] [--spp N] ' +
      '[--draws N] [--tile N] [--frame N] [--seed N] [--depth 8|16] [--preset name] [--out path]');
  }
  return { piece: positional[0], flags };
}

function pieceDir(id: string): string {
  const dir = readdirSync(path.join(ROOT, 'artwork')).find((d) => d.startsWith(`${id}-`));
  if (!dir) throw new Error(`no artwork directory for piece ${id}`);
  return path.join('artwork', dir);
}

const { piece, flags } = parseArgs(process.argv.slice(2));
const dir = pieceDir(piece);
const meta = JSON.parse(readFileSync(path.join(ROOT, dir, 'meta.json'), 'utf8')) as {
  still?: { width?: number; height?: number; spp?: number };
  poster?: { frame?: number; seed?: number };
  passes?: unknown[];
  preset?: string;
  presets?: { name: string; values: Record<string, unknown> }[];
};

const num = (name: string, fallback: number) =>
  flags[name] !== undefined ? Number(flags[name]) : fallback;

const width = num('width', meta.still?.width ?? 2000);
const height = num('height', meta.still?.height ?? 2000);
const spp = num('spp', 4);
// Total samples come from meta's `still.spp`; splitting them across draws is
// what keeps any single draw short enough for the driver watchdog.
const draws = num('draws', Math.max(1, Math.round((meta.still?.spp ?? 8) / spp)));
const tile = num('tile', 1024);
// 8 bits is the deliverable's precision, not the work's. The resolve pass
// dithers, so an 8-bit file is safe to LOOK at; 16 bits is for a file something
// else will edit, where re-quantising an already-quantised image bands it again.
const depth = num('depth', 8) === 16 ? 16 : 8;
// One time knob. For a stateful piece, frame N means N simulation steps since
// seeding, so the poster frame in meta.json is where the simulation has got to.
const frame = num('frame', meta.poster?.frame ?? 0);
const seed = num('seed', meta.poster?.seed ?? 0);
// The preset belongs in the filename, or rendering two looks at the same size
// silently leaves you with one file and no way to tell which look it holds.
const chosen = chosenPreset(meta, flags.preset);
const out = flags.out
  ? path.resolve(ROOT, flags.out)
  : path.join(ROOT, dir, 'out',
    `still-${width}x${height}${chosen ? `-${chosen.replace(/[^\w-]+/g, '_')}` : ''}.png`);

const session = await launch(5211);
try {
  await session.open(`?p=${piece}`);
  const err = await session.page.evaluate(() => window.__pa.error);
  if (err) throw new Error(`shader failed to compile:\n${err}`);
  await session.page.evaluate((s: number) => window.__pa.setSeed(s), seed);
  // Before the render, not after: a stale preset must stop the run rather than
  // waste ten minutes of tiles on the wrong picture.
  const preset = await usePreset(session.page, meta, flags.preset, `render ${piece}`);

  const started = Date.now();
  process.stdout.write(
    `${piece}: ${width}x${height}, ${draws} x ${spp} = ${draws * spp} samples, ` +
      `${tile}px tiles, ${depth}-bit, frame ${frame}` +
      `${preset ? `, preset "${preset}"` : ''}\n`,
  );

  const image = await renderStillAt(session.page, {
    width, height, tile, draws, spp, frame, depth,
    onProgress(done, total) {
      process.stdout.write(`\r  tile ${done}/${total}`);
    },
  });

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, depth === 16
    ? encodePng16(image as Image16)
    : encodePng(image as Image));
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n  wrote ${path.relative(ROOT, out)} in ${secs}s\n`);

  if (session.consoleErrors.length) {
    process.stdout.write(`  console errors:\n    ${session.consoleErrors.join('\n    ')}\n`);
    process.exitCode = 1;
  }
} finally {
  await session.close();
}
