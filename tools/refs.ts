/**
 * Regenerate golden reference images.
 *
 *   npm run ref            # every piece
 *   npm run ref -- 001     # one piece
 *
 * Run this only when a difference the reference test reported was intended.
 * Regenerating to make a red test go green is how a regression net stops
 * catching anything.
 */
import { compare, glInfo, pieceRefs, readReference, renderReference, writeReference } from './ref.ts';
import { launch } from './session.ts';

const ids = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
const refs = pieceRefs(ids.length ? ids : undefined);
if (refs.length === 0) {
  console.error(`no pieces match ${ids.join(', ')}`);
  process.exit(2);
}

const s = await launch(5213);
try {
  await s.open('?p=001');
  const gl = await glInfo(s.page);
  console.log(`renderer: ${gl.renderer}`);

  for (const ref of refs) {
    await s.open(`?p=${ref.id}`);
    const err = await s.page.evaluate(() => window.__pa.error);
    if (err) {
      console.error(`${ref.id}: shader failed to compile\n${err}`);
      process.exitCode = 1;
      continue;
    }
    const before = readReference(ref);
    const image = await renderReference(s.page, ref);
    writeReference(ref, image, gl);

    const changed = before && before.image.width === image.width
      ? compare(before.image, image)
      : null;
    const what = !before
      ? 'created'
      : changed && changed.equal
        ? 'unchanged'
        : `CHANGED (${changed ? changed.differing : '?'} pixels)`;
    console.log(
      `  ${ref.id}  ${ref.config.size}px, ${ref.config.draws * ref.config.spp} samples` +
        `${ref.config.frame ? `, frame ${ref.config.frame}` : ''}  ->  ${what}`,
    );
  }

  if (s.consoleErrors.length) {
    console.error(`console errors:\n  ${s.consoleErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await s.close();
}
