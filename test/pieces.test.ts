/**
 * Artwork discovery.
 *
 * `pieces.ts` used to import every piece by name, so a typo in a buffer shader
 * name or an id that disagreed with its directory was a compile error. Now a
 * piece is just a directory, and all of those become runtime problems — the
 * kind that produce a page that half-loads, or a CLI and a browser that quietly
 * disagree about which artwork "003" is.
 *
 * So the refusals are the feature, and this suite is what says they are still
 * there. Every check below is a mistake somebody will actually make while
 * adding piece 004 at midnight.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PA_TONEMAP, buildPiece, DIR_PATTERN, type ShaderModule } from '../visualization/piece.ts';
import { launch, ROOT } from '../tools/session.ts';
import { check, note, section, throwsMessage } from './harness.ts';

section('pieces');

const shader = (kind: 'image' | 'buffer'): ShaderModule => ({
  code: '', map: [], entry: 'x.frag', kind, params: [], buffers: [],
});

const META = { id: '004', slug: 'lattice', title: 'Lattice' };
const FILES = { 'main.frag': shader('image') };

// --- the happy path ----------------------------------------------------------

{
  const p = buildPiece('004-lattice', META, FILES);
  check('a directory with meta.json and main.frag is a piece',
    p.id === '004' && p.title === 'Lattice' && p.dir === 'artwork/004-lattice',
    `${p.id} ${p.title} ${p.dir}`);
  check('a piece with no passes declares none', p.passes.length === 0);
}

{
  const p = buildPiece(
    '004-lattice',
    { ...META, passes: [{ id: 'a', shader: 'buffer-a.frag', size: 256, substeps: 4 }] },
    { ...FILES, 'buffer-a.frag': shader('buffer') },
  );
  check('a declared pass is wired to its shader',
    p.passes.length === 1 && p.passes[0].id === 'a' && p.passes[0].size === 256 &&
      p.passes[0].substeps === 4);
}

{
  const withParams = (name: string, kind: 'image' | 'buffer') => ({
    ...shader(kind),
    params: [{ name, kind: 'float', label: name, min: 0, max: 1, value: 0 }],
  }) as unknown as ShaderModule;
  const p = buildPiece(
    '004-lattice',
    { ...META, passes: [{ id: 'a', shader: 'buffer-a.frag' }] },
    { 'main.frag': withParams('uContrast', 'image'),
      'buffer-a.frag': withParams('uFeed', 'buffer') },
  );
  // A piece's parameters live where they are used — feed in the simulation,
  // contrast in the display — but the GUI and the URL hash need one flat set.
  //
  // The display rows come last and come from viz, not from any shader:
  // exposure, tonemap and bloom are the resolve pass's business, declared in
  // meta.json. They are ordinary parameters on purpose, which is what gets
  // them a GUI row, a slot in the URL hash and a slot in a captured preset
  // without a second mechanism.
  const DISPLAY = 'uDisplayExposure,uBloomStrength,uBloomThreshold,uDisplayTonemap';
  const names = p.params.map((s) => s.name).join(',');
  check('parameters from the image pass and the buffer passes are merged',
    names === `uContrast,uFeed,${DISPLAY}`, names);

  // Every piece gets them, whether or not meta.json mentions display.
  const bare = buildPiece('004-lattice', META, { 'main.frag': withParams('uContrast', 'image') });
  check('a piece with no display block still gets the display transform',
    bare.params.map((s) => s.name).join(',') === `uContrast,${DISPLAY}`,
    bare.params.map((s) => s.name).join(','));
  check('bloom is off unless the piece asks for it',
    (bare.params.find((s) => s.name === 'uBloomStrength') as { def: number }).def === 0);
  const tm = bare.params.find((s) => s.name === 'uDisplayTonemap');
  check('the default transform is ACES at zero stops',
    tm?.kind === 'enum' && tm.def === PA_TONEMAP.indexOf('aces') &&
      (bare.params.find((s) => s.name === 'uDisplayExposure') as { def: number }).def === 0,
    `tonemap def ${tm && 'def' in tm ? tm.def : '?'}`);
}

// --- the refusals ------------------------------------------------------------

// The display block is the one part of meta.json a person types by hand and
// gets wrong by typo, so it refuses by name rather than falling back silently.
await throwsMessage('an unknown tonemap name is refused',
  () => buildPiece('004-lattice', { ...META, display: { tonemap: 'filmic' } }, FILES),
  'display.tonemap');

await throwsMessage('an absurd exposure is refused',
  () => buildPiece('004-lattice', { ...META, display: { exposure: 40 } }, FILES),
  'display.exposure');


await throwsMessage('a directory not named <id>-<slug> is refused',
  () => buildPiece('lattice', META, FILES), '<id>-<slug>');

await throwsMessage('an id that disagrees with the directory is refused',
  () => buildPiece('004-lattice', { ...META, id: '005' }, FILES), 'expected "004"');

await throwsMessage('a slug that disagrees with the directory is refused',
  () => buildPiece('004-lattice', { ...META, slug: 'trellis' }, FILES), 'expected "lattice"');

await throwsMessage('a missing meta.json is refused',
  () => buildPiece('004-lattice', undefined, FILES), 'meta.json id');

await throwsMessage('a piece with no title is refused',
  () => buildPiece('004-lattice', { id: '004', slug: 'lattice' }, FILES), 'needs a title');

await throwsMessage('a directory with no main.frag is refused',
  () => buildPiece('004-lattice', META, { 'buffer-a.frag': shader('buffer') }), 'no main.frag');

await throwsMessage('a main.frag that is a buffer pass is refused',
  () => buildPiece('004-lattice', META, { 'main.frag': shader('buffer') }),
  'image pass must be main.frag');

// Presets are addressed by name everywhere — the GUI dropdown, every CLI's
// --preset, meta.json's own `preset` field — so a duplicate name makes one of
// them permanently unreachable, and the unreachable one is whichever was
// captured second. That is the one you just made.
await throwsMessage('two presets sharing a name are refused',
  () => buildPiece('004-lattice', {
    ...META,
    presets: [{ name: 'dusk', values: {} }, { name: 'dusk', values: { uA: 1 } }],
  }, FILES),
  'two presets named "dusk"');

await throwsMessage('a preset with no name is refused',
  () => buildPiece('004-lattice', { ...META, presets: [{ values: {} }] }, FILES),
  'preset with no name');

// Without this the piece renders its defaults from every CLI at once, which is
// indistinguishable from a piece that declared no preset at all.
await throwsMessage('naming a default preset the piece does not have is refused',
  () => buildPiece('004-lattice', {
    ...META, preset: 'noon', presets: [{ name: 'dusk', values: {} }],
  }, FILES),
  'not one of its presets (dusk)');

check('a piece may declare one of its own presets as the default',
  buildPiece('004-lattice', {
    ...META, preset: 'dusk', presets: [{ name: 'dusk', values: {} }],
  }, FILES).meta.preset === 'dusk');

// The one most likely to happen: renaming buffer-a.frag and forgetting meta.json.
await throwsMessage('a pass naming a shader that is not there is refused, and lists what is',
  () => buildPiece('004-lattice', { ...META, passes: [{ id: 'a', shader: 'buffer-b.frag' }] },
    { ...FILES, 'buffer-a.frag': shader('buffer') }),
  'found: buffer-a.frag, main.frag');

await throwsMessage('a pass pointing at the image shader is refused',
  () => buildPiece('004-lattice', { ...META, passes: [{ id: 'a', shader: 'main.frag' }] }, FILES),
  'not a buffer pass');

await throwsMessage('two passes with the same id are refused',
  () => buildPiece('004-lattice',
    { ...META, passes: [{ id: 'a', shader: 'buffer-a.frag' },
                        { id: 'a', shader: 'buffer-a.frag' }] },
    { ...FILES, 'buffer-a.frag': shader('buffer') }),
  'share the id');

// --- the real directories ----------------------------------------------------

const dirs = readdirSync(path.join(ROOT, 'artwork'))
  .filter((d) => !d.startsWith('.') && d !== 'out')
  .sort();

{
  check('every directory under artwork/ is named <id>-<slug>',
    dirs.every((d) => DIR_PATTERN.test(d)),
    dirs.join(', '));

  // The consistency the CLIs depend on: `npm run render -- 003` finds the
  // directory by its numeric prefix, the page finds the piece by meta.id, and
  // the video CLI names its output from meta.slug. If those three disagree,
  // three tools are looking at different artworks with the same name.
  const bad: string[] = [];
  for (const d of dirs) {
    const meta = JSON.parse(
      readFileSync(path.join(ROOT, 'artwork', d, 'meta.json'), 'utf8'),
    ) as { id?: string; slug?: string };
    const [id, ...slug] = d.split('-');
    if (meta.id !== id) bad.push(`${d}: id ${meta.id}`);
    if (meta.slug !== undefined && meta.slug !== slug.join('-')) bad.push(`${d}: slug ${meta.slug}`);
  }
  check('every meta.json agrees with its directory name', bad.length === 0, bad.join('; '));
  note(`${dirs.length} pieces: ${dirs.join(', ')}`);
}

// --- the actual claim: a piece is a directory --------------------------------

/**
 * Everything above tests the validation. This tests the promise: drop a
 * directory into artwork/ and it is a piece, with no TypeScript edited
 * anywhere. Worth doing against the real toolchain rather than by argument —
 * `import.meta.glob` is resolved at build time, and whether a directory that
 * appears AFTER the dev server started is picked up is a property of Vite, not
 * of anything in this repo.
 */
{
  const probe = path.join(ROOT, 'artwork', '999-probe');
  const s = await launch(5207);
  try {
    // Derived from the directory listing, never hardcoded: a hardcoded list is
    // a second registry, and re-introducing one here would be the exact thing
    // this whole mechanism removed.
    const expected = dirs.map((d) => d.split('-')[0]).join(',');
    const before = await (async () => {
      await s.open('?p=001');
      return s.page.evaluate(() => window.__pa.pieces);
    })();
    check('the page discovers every committed piece', before.join(',') === expected,
      `${before.join(',')} vs ${expected}`);

    mkdirSync(probe, { recursive: true });
    writeFileSync(path.join(probe, 'meta.json'),
      JSON.stringify({ id: '999', slug: 'probe', title: 'Probe' }, null, 2));
    writeFileSync(path.join(probe, 'main.frag'),
      'void mainImage(out vec4 o, in vec2 f) { o = vec4(artCoord(f), 0.0, 1.0); }\n');

    await s.open('?p=999');
    const after = await s.page.evaluate(() => ({
      pieces: window.__pa.pieces, piece: window.__pa.piece, error: window.__pa.error,
    }));
    check('a directory added to artwork/ becomes a piece with no code changes',
      after.pieces.includes('999') && after.piece === '999' && !after.error,
      `${after.pieces.join(',')}${after.error ? `\n        ${after.error}` : ''}`);
  } finally {
    rmSync(probe, { recursive: true, force: true });
    await s.close();
  }
}
