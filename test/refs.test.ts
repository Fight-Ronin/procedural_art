/**
 * Golden reference images: does the current code still make the same picture?
 *
 * This is the net under every future change to `basics/`. A tweak to fbm that
 * quietly alters 001 is not otherwise detectable — nothing else in the suite
 * compares against what a piece USED to look like.
 *
 * Comparison is bit-exact, and skipped rather than loosened when the renderer
 * differs from the one the reference was made on. A tolerance would hide the
 * small regressions this exists to catch.
 */
import path from 'node:path';
import { fingerprint, fingerprintDiff } from '../tools/fingerprint.ts';
import {
  compare,
  glInfo,
  pieceRefs,
  readReference,
  renderReference,
  writeDiff,
} from '../tools/ref.ts';
import { launch, ROOT } from '../tools/session.ts';
import { check, note, section, skip } from './harness.ts';

section('reference images');

const only = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
const refs = pieceRefs(only.length ? only : undefined);

const s = await launch(5203);
try {
  const gl = await (async () => {
    await s.open('?p=001');
    return glInfo(s.page);
  })();
  note(`renderer: ${gl.renderer}`);

  for (const ref of refs) {
    const stored = readReference(ref);
    if (!stored) {
      check(`${ref.id} has a reference image`, false,
        `missing ${path.basename(ref.pngPath)} — run: npm run ref -- ${ref.id}`);
      continue;
    }
    check(`${ref.id} has a reference image`, true);

    // A reference rendered at different settings is not a reference for these.
    const same = JSON.stringify(stored.provenance.config) === JSON.stringify(ref.config);
    if (!check(`${ref.id} reference matches the declared settings`, same,
      same ? '' : `stored ${JSON.stringify(stored.provenance.config)} vs ` +
        `meta ${JSON.stringify(ref.config)} — run: npm run ref -- ${ref.id}`)) {
      continue;
    }

    if (stored.provenance.renderer !== gl.renderer) {
      skip(`${ref.id} matches its reference`,
        `reference was made on "${stored.provenance.renderer}", this is "${gl.renderer}". ` +
          'Bit-exact comparison is only meaningful on the renderer that produced it.');
      continue;
    }

    await s.open(`?p=${ref.id}`);
    const err = await s.page.evaluate(() => window.__pa.error);
    if (!check(`${ref.id} compiles`, !err, err ?? '')) continue;

    const actual = await renderReference(s.page, ref);
    const cmp = compare(stored.image, actual);
    if (cmp.equal) {
      check(`${ref.id} matches its reference`, true,
        `${ref.config.size}px, ${ref.config.draws * ref.config.spp} samples`);
    } else {
      const diff = writeDiff(ref, stored.image, actual);
      const b = cmp.bbox!;
      // Which side moved. "basics/ has changed" is the first thing anyone wants
      // to know here, and guessing it from the diff image is a waste of a
      // question the tool can answer outright. All three unchanged is itself
      // informative: the renderer moved, or something in viz that should not
      // be able to touch pixels does.
      const moved = stored.provenance.sources
        ? fingerprintDiff(stored.provenance.sources, fingerprint(ROOT, ref.dir))
        : ['(this reference predates source fingerprints)'];
      check(`${ref.id} matches its reference`, false,
        `${cmp.differing}/${cmp.total} pixels differ, mean ${cmp.meanAbs.toFixed(3)}, ` +
          `max ${cmp.maxAbs}, bbox ${b.x0},${b.y0}..${b.x1},${b.y1}\n        ` +
          `since the reference was made: ${moved.length ? moved.join('; ') : 'NOTHING in basics/, build/ or the piece — look at viz or the driver'}\n        ` +
          `see ${diff.path} (differences amplified ${diff.gain.toFixed(0)}x)` +
          ` — if the change was intended: npm run ref -- ${ref.id}`);
    }
  }

  // Reproducibility within one process: the same reference rendered twice must
  // agree, or the comparison above is measuring noise rather than regressions.
  if (refs.length > 0) {
    const ref = refs[0];
    await s.open(`?p=${ref.id}`);
    const a = await renderReference(s.page, ref);
    const b = await renderReference(s.page, ref);
    check(`${ref.id} renders identically twice in a row`, compare(a, b).equal);
  }

  check('no console errors while checking references', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));
} finally {
  await s.close();
}
