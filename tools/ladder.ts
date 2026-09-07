/**
 * Overall ink level across a ladder of output sizes.
 *
 *   npm run ladder -- 001
 *   npm run ladder -- 001 --sizes 300,600,900,1800
 *
 * `test/render.test.ts` compares two resolutions and asserts a bound. This
 * prints the trend across four or five, which answers a different question: not
 * "did it pass" but "which way is it going and does it settle". A piece can sit
 * just inside the tolerance at 300 vs 900 and still be walking steadily in one
 * direction, and at 4000px for print that walk is the whole story.
 *
 * The number reported is the mean of the encoded 8-bit image. It is deliberately
 * the crudest possible statistic: anything resolution-dependent in the shading —
 * an edge width in pixels, a marcher whose step count changes what it finds, an
 * effect whose sample count is tied to the output — moves it, and nothing else
 * does, because the piece is otherwise the same picture.
 */
import { renderStill } from './export.ts';
import { pieceRefs } from './ref.ts';
import { launch } from './session.ts';
// Undoing the display encode before averaging is shared with test/render.test.ts;
// see tools/tone.ts for why it must be exactly one implementation.
import { levels } from './tone.ts';

const args = process.argv.slice(2);
const ids = args.filter((a) => /^\d{3}$/.test(a));
const sizesArg = args[args.indexOf('--sizes') + 1];
const SIZES = args.includes('--sizes')
  ? sizesArg.split(',').map(Number)
  : [300, 600, 900, 1800];

const pieces = pieceRefs(ids.length ? ids : undefined);
if (pieces.length === 0) {
  console.error(`no pieces match ${ids.join(', ')}`);
  process.exit(2);
}

const session = await launch(5219);
try {
  for (const p of pieces) {
    const encoded: number[] = [];
    const linears: number[] = [];
    for (const size of SIZES) {
      await session.open(`?p=${p.id}`);
      const img = await renderStill(session.page, {
        width: size, height: size, tile: 1024, draws: 1, spp: 4, frame: 0,
      });
      const lv = levels(img.data);
      encoded.push(lv.encoded);
      linears.push(lv.linear);
    }
    const spread = Math.max(...encoded) - Math.min(...encoded);
    const lspread = Math.max(...linears) - Math.min(...linears);
    const cells = SIZES.map((s, i) => `${s}px ${encoded[i].toFixed(2)}`).join('   ');
    const lcells = SIZES.map((s, i) => `${s}px ${linears[i].toFixed(2)}`).join('   ');
    console.log(`  ${p.id}  encoded  ${cells}   spread ${spread.toFixed(2)}/255`);
    console.log(`  ${p.id}  linear   ${lcells}   spread ${lspread.toFixed(2)}/255`);
  }
  if (session.consoleErrors.length) {
    console.error(`console errors:\n  ${session.consoleErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await session.close();
}