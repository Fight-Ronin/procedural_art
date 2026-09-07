/**
 * Parameter contact sheets.
 *
 *   npm run sheet -- 007 uScale=6,9,12
 *   npm run sheet -- 007 uScale=6,9,12 uEmpty=0.1,0.25,0.4 --size 320
 *
 * The first parameter varies across columns, the second down rows.
 *
 * This exists because of a lesson the repo already learned and then did not
 * keep: 004's flow smearing was argued about for three rounds of theory and
 * settled in five minutes by rendering a 3x3 grid of parameter values and
 * looking at it. That grid was thrown away afterwards, so the next piece had
 * to build one by hand again. A visual question deserves a visual answer, and
 * the tool for getting one should not be rewritten each time.
 *
 * No labels are drawn on the image. Text rendering would be the largest thing
 * in this file and the mapping is printed to stdout, which is where the person
 * reading it already is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderStill } from './export.ts';
import { readMeta, usePreset } from './preset.ts';
import { pieceRefs } from './ref.ts';
import { encodePng, type Image } from './png.ts';
import { launch, ROOT } from './session.ts';

const args = process.argv.slice(2);
// A flag's value is not a piece id, even when it looks exactly like one:
// `--size 300` used to be read as "also render piece 300".
const ids = args.filter((a, i) => /^\d{3}$/.test(a) && !(i > 0 && args[i - 1].startsWith('--')));
const flag = (name: string, dflt: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const PRESET = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : undefined;
const SIZE = flag('size', 300);
const SPP = flag('spp', 4);
const FRAME = flag('frame', 0);
const GUTTER = 10;

const axes = args
  .filter((a) => a.includes('=') && !a.startsWith('--'))
  .map((a) => {
    const [name, list] = a.split('=');
    return { name, values: list.split(',').map(Number) };
  });

if (ids.length !== 1 || axes.length === 0 || axes.length > 2) {
  console.error('usage: npm run sheet -- <id> <param>=<v,v,v> [<param>=<v,v,v>] [--size N] [--spp N] [--frame N] [--preset name]');
  process.exit(2);
}
const piece = pieceRefs(ids)[0];
const cols = axes[0].values;
const rows = axes[1]?.values ?? [0];

const cellW = SIZE;
const cellH = SIZE;
const sheetW = cols.length * cellW + (cols.length - 1) * GUTTER;
const sheetH = rows.length * cellH + (rows.length - 1) * GUTTER;
const data = new Uint8Array(sheetW * sheetH * 4).fill(255);

const session = await launch(5221);
try {
  await session.open(`?p=${piece.id}`);
  const err = await session.page.evaluate(() => window.__pa.error);
  if (err) {
    console.error(`${piece.id} failed to compile\n${err}`);
    process.exit(1);
  }

  // The sheet varies parameters AROUND a base, and the base is worth choosing:
  // refining an existing look means sweeping one knob from that look, not from
  // the shader's defaults with the other seven knobs back at their originals.
  const base = await usePreset(session.page, readMeta(piece.dir), PRESET, `sheet ${piece.id}`);
  if (base) console.log(`${piece.id}  base:    preset "${base}"`);

  console.log(`${piece.id}  columns: ${axes[0].name} = ${cols.join(', ')}`);
  if (axes[1]) console.log(`${piece.id}  rows:    ${axes[1].name} = ${rows.join(', ')}`);

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      await session.page.evaluate(
        (p: { n: string; v: number }) => window.__pa.setParam(p.n, p.v),
        { n: axes[0].name, v: cols[c] },
      );
      if (axes[1]) {
        await session.page.evaluate(
          (p: { n: string; v: number }) => window.__pa.setParam(p.n, p.v),
          { n: axes[1].name, v: rows[r] },
        );
      }
      const img: Image = await renderStill(session.page, {
        width: cellW, height: cellH, tile: 1024, draws: 1, spp: SPP, frame: FRAME,
      });
      const x0 = c * (cellW + GUTTER);
      const y0 = r * (cellH + GUTTER);
      for (let y = 0; y < cellH; y++) {
        const src = y * cellW * 4;
        const dst = ((y0 + y) * sheetW + x0) * 4;
        data.set(img.data.subarray(src, src + cellW * 4), dst);
      }
    }
  }

  const out = path.join(ROOT, piece.dir, 'out', 'sheet.png');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, encodePng({ width: sheetW, height: sheetH, data }));
  console.log(`  ${cols.length} x ${rows.length} at ${SIZE}px  ->  ${path.relative(ROOT, out)}`);

  if (session.consoleErrors.length) {
    console.error(`console errors:\n  ${session.consoleErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await session.close();
}
