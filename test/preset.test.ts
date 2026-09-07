/**
 * Named looks, and the refusals that make them trustworthy.
 *
 * A preset is a dictionary of parameter values dropped into a store that is
 * deliberately forgiving — `ParamStore.load` ignores names it does not know and
 * `coerce` clamps values into range. That forgiveness is correct for a URL
 * hash, which gets pasted between versions of a piece and should degrade
 * instead of exploding. It is exactly wrong for a preset, because the whole
 * claim a preset makes is "this reproduces that picture".
 *
 * So the interesting cases here are all failures. Any one of them, unchecked,
 * produces a render that is subtly not the look you asked for, with nothing
 * anywhere reporting a problem:
 *
 *   - a name that no longer exists (a uniform was renamed) — that parameter
 *     silently falls back to its default while every other value applies
 *   - a value outside the parameter's range (a slider was narrowed) — silently
 *     clamped
 *   - a preset name that does not exist — silently renders the defaults, which
 *     is the most dangerous of the three because it looks like it worked
 *
 * The last one is why `--preset` was worth building carefully rather than
 * quickly. A typo that renders SOMETHING is worse than a typo that renders
 * nothing: an eight-minute print of the wrong look is only discovered by
 * remembering what the right one looked like.
 */
import { chosenPreset, resolvePreset, type Preset } from '../tools/preset.ts';
import { manifestConflicts, type Manifest } from '../tools/manifest.ts';
import { fingerprint } from '../tools/fingerprint.ts';
import { launch, ROOT } from '../tools/session.ts';
import { check, note, section, throwsMessage } from './harness.ts';

section('presets');

// --- choosing which preset to use -------------------------------------------
//
// Pure precedence, no browser. `--preset` beats meta.json, meta.json beats
// nothing, and the literal `none` beats both back to the shader's defaults.
{
  const meta = { preset: 'dusk', presets: [] };
  check('--preset overrides the piece declaration',
    chosenPreset(meta, 'noon') === 'noon');
  check('meta.json "preset" applies when no flag is given',
    chosenPreset(meta, undefined) === 'dusk');
  check('--preset none means the shader defaults, overriding meta.json',
    chosenPreset(meta, 'none') === null);
  check('a piece declaring nothing renders its defaults',
    chosenPreset({}, undefined) === null);
}

// --- the refusal, and what it tells you --------------------------------------
{
  const withPresets = {
    presets: [
      { name: 'dusk', values: {} },
      { name: 'noon', values: {} },
    ] as Preset[],
  };
  await throwsMessage('a preset name that does not exist is refused, not ignored',
    () => resolvePreset(withPresets, 'dusl', 'render 008'), 'no preset named "dusl"');
  // The listing is the actually useful half: a typo and a look that was never
  // captured are the same error message without it.
  await throwsMessage('the refusal lists what the piece does have',
    () => resolvePreset(withPresets, 'dusl', 'render 008'), 'available: dusk, noon');
  await throwsMessage('a piece with no presets says so rather than listing nothing',
    () => resolvePreset({ presets: [] }, 'dusk', 'render 008'), 'has no presets yet');

  check('a preset that exists resolves to its values',
    resolvePreset(withPresets, 'noon', 'x').name === 'noon');
}

// --- resuming a video across a preset change ---------------------------------
//
// A preset changes every pixel of every frame and moves none of the other
// manifest fields: same shaders, same size, same sample counts. Without this
// key, `--resume` after switching looks would splice two different pictures
// into one video at whatever frame the first run died on.
{
  const base: Manifest = {
    piece: '008', width: 640, height: 640, fps: 60, spp: 4, draws: 2, start: 0,
    preset: null, sources: fingerprint(ROOT, 'artwork/008-ember'),
  };
  check('resuming into frames rendered with the same look is allowed',
    manifestConflicts(base, { ...base }).length === 0);
  const conflicts = manifestConflicts({ ...base, preset: 'dusk' }, base);
  check('resuming across a preset change is refused',
    conflicts.some((c) => c.startsWith('preset:')), conflicts.join('; '));
  check('the refusal names both looks',
    conflicts.some((c) => c.includes('dusk') && c.includes('the declared defaults')),
    conflicts.join('; '));
  // Manifests written before presets existed have no field at all. Reading that
  // as "a different look" would refuse every resume into an older directory.
  const legacy = { ...base } as Manifest;
  delete legacy.preset;
  check('a manifest written before presets is not treated as a different look',
    manifestConflicts(base, legacy).length === 0,
    manifestConflicts(base, legacy).join('; '));
}

// --- applying one to a real page ---------------------------------------------
//
// The three failure modes above are properties of the page's parameter store,
// so they are checked against the store rather than against a model of it.
const s = await launch(5225);
try {
  await s.open('?p=008');
  const err = await s.page.evaluate(() => window.__pa.error);
  if (err) throw new Error(`008 failed to compile:\n${err}`);

  const snapshot = await s.page.evaluate(() => {
    const spec = window.__pa.store.specs;
    return { names: spec.map((x) => x.name), specs: spec };
  });
  note(`008 declares ${snapshot.names.length} parameters`);

  // A round trip must be a fixed point: whatever the page reports as its
  // current values must apply back onto it with nothing unknown and nothing
  // changed. Every "changed" check below is only meaningful because this holds.
  {
    const miss = await s.page.evaluate(() => {
      const before = window.__pa.snapshot();
      return window.__pa.loadValues(before);
    });
    check('a captured snapshot re-applies exactly (round trip is a fixed point)',
      miss.unknown.length === 0 && miss.changed.length === 0,
      `unknown: ${miss.unknown.join(', ') || 'none'}; changed: ${miss.changed.join(', ') || 'none'}`);
  }

  // A renamed uniform. This is the common one in practice: a piece is edited,
  // a parameter gets a better name, and every preset captured before the edit
  // now half-applies.
  {
    const miss = await s.page.evaluate(() =>
      window.__pa.loadValues({ uDensity: 6, uWasRenamed: 0.5, uAlsoGone: 1 }));
    check('a preset naming parameters the piece does not declare reports them',
      miss.unknown.length === 2 && miss.unknown.includes('uWasRenamed'),
      miss.unknown.join(', '));
    check('names the piece DOES declare are not reported as unknown',
      !miss.unknown.includes('uDensity'));
  }

  // A narrowed range. uDensity is declared 0.5 .. 20.0, so 999 cannot survive
  // and must be reported rather than quietly becoming 20.
  {
    const miss = await s.page.evaluate(() => window.__pa.loadValues({ uDensity: 999 }));
    check('a value outside the parameter range is reported, not silently clamped',
      miss.changed.includes('uDensity'), miss.changed.join(', '));
  }

  // An enum that lost its option. `coerce` substitutes options[0], which is a
  // completely different display transform applied without comment.
  {
    const miss = await s.page.evaluate(() => window.__pa.loadValues({ uDisplayTonemap: 77 }));
    check('an enum value with no matching option is reported',
      miss.changed.includes('uDisplayTonemap'), miss.changed.join(', '));
  }

  // Colours travel as "#rrggbb" and are the one kind `setParam` cannot carry at
  // all, which is why `loadValues` exists as a separate entry point.
  {
    const miss = await s.page.evaluate(() =>
      window.__pa.loadValues({ uFlame: '#3366CC' }));
    check('a hex colour applies through loadValues without being reported changed',
      miss.unknown.length === 0 && miss.changed.length === 0,
      `unknown: ${miss.unknown.join(', ')}; changed: ${miss.changed.join(', ')}`);
    const back = await s.page.evaluate(() => window.__pa.snapshot().uFlame);
    check('and round-trips to the same colour, case-insensitively',
      String(back).toLowerCase() === '#3366cc', String(back));
  }

  // Finally: a preset must actually change the picture. Every check above would
  // pass on a `loadValues` that reported honestly and applied nothing.
  {
    const before = await s.page.evaluate(() => window.__pa.renderAt(48, 48, 0, 1));
    await s.page.evaluate(() => window.__pa.loadValues({ uEmit: 0.2, uDensity: 1.0 }));
    const after = await s.page.evaluate(() => window.__pa.renderAt(48, 48, 0, 1));
    let diff = 0;
    for (let i = 0; i < before.length; i++) diff += Math.abs(before[i] - after[i]);
    diff /= before.length;
    check('applying a preset changes what renders', diff > 1.0, `mean |delta| = ${diff.toFixed(2)}`);
  }
} finally {
  await s.close();
}
