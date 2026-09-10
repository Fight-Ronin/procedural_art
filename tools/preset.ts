/**
 * Named looks, resolved for the headless renderers.
 *
 * The viewer has been able to capture a preset since block 8 — drag the
 * sliders, press the button, and `meta.json` grows a named set of values. What
 * it could not do was render one: `npm run render` and `npm run video` read
 * nothing but the piece's declared defaults, so the only look you could print
 * was the one that happened to be compiled in. A look you can find but cannot
 * print is not a look you have.
 *
 * This module is the resolution half, shared by every CLI so that all of them
 * refuse identically.
 *
 * EVERY FAILURE HERE IS LOUD, and that is the whole design. A preset is a
 * dictionary applied to a parameter store that silently ignores names it does
 * not know (`ParamStore.load`) and silently clamps values out of range
 * (`coerce`). Both behaviours are right for a URL hash, which is pasted between
 * versions and should degrade rather than explode. Both are catastrophic for a
 * preset: rename a uniform, or narrow a slider, and every print made from that
 * preset silently becomes a different picture — with no error, no warning, and
 * no way to notice except by remembering what it used to look like.
 *
 * So the contract is: a preset either reproduces exactly, or nothing renders.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { ROOT } from './session.ts';

export interface Preset {
  name: string;
  values: Record<string, unknown>;
}

interface PresetMeta {
  /**
   * The look every headless renderer uses unless `--preset` overrides it.
   *
   * One field rather than one per output block. A person who has just found a
   * good look should not have to remember to name it in `still`, `poster`,
   * `video` and `thumb` separately — the overwhelmingly common case is that a
   * piece has one canonical appearance, and the CLI flag covers the rest.
   */
  preset?: string;
  presets?: Preset[];
}

/** The literal `--preset` value meaning "the shader's declared defaults". */
export const PRESET_NONE = 'none';

export function readMeta(dir: string): PresetMeta {
  return JSON.parse(readFileSync(path.join(ROOT, dir, 'meta.json'), 'utf8')) as PresetMeta;
}

/**
 * Which preset a run should use: the flag if given, else the piece's own
 * declaration, else none.
 *
 * `--preset none` is spelled out rather than left to "pass nothing", because
 * "nothing" already means "whatever meta.json says" — and overriding a piece
 * that declares a preset back to bare defaults is a thing you genuinely want
 * when comparing a look against the shader's baseline.
 */
export function chosenPreset(meta: PresetMeta, flag: string | undefined): string | null {
  const name = flag ?? meta.preset;
  if (!name || name === PRESET_NONE) return null;
  return name;
}

/**
 * Look up a preset by name, or explain what is actually on offer.
 *
 * The listing in the error matters more than the refusal does. A typo and a
 * preset that was never captured produce the same message from the renderer's
 * point of view, and the difference — "you meant `dusk`" versus "this piece has
 * none yet" — is exactly what the available list shows at a glance.
 */
export function resolvePreset(meta: PresetMeta, name: string, where: string): Preset {
  const presets = meta.presets ?? [];
  const found = presets.find((p) => p.name === name);
  if (found) return found;

  const available = presets.map((p) => p.name);
  throw new Error(
    `${where}: no preset named ${JSON.stringify(name)}\n` +
      (available.length
        ? `  available: ${available.join(', ')}`
        : '  this piece has no presets yet — capture one in the viewer') +
      `\n  (--preset ${PRESET_NONE} renders the shader's declared defaults)`,
  );
}

/**
 * Apply a preset to a loaded page, refusing anything that did not land exactly.
 *
 * The page reports back two kinds of miss and both are fatal:
 *
 *   unknown — the preset names a parameter the piece no longer declares. The
 *     usual cause is a renamed uniform, and the usual symptom without this
 *     check is a print that looks like the defaults for one of its values and
 *     the preset for all the others.
 *
 *   changed — the value came back different from the one requested, which means
 *     it was clamped into a narrowed range, rounded to an int, or fell through
 *     an enum that no longer has that option. The preset is then not
 *     reproducible, whatever the picture looks like.
 *
 *   unspecified — the piece declares a parameter the preset does not name. This
 *     is the OPPOSITE direction from `unknown` and it was missed for a long
 *     time, because it produces no error anywhere: the parameter simply keeps
 *     whatever value it already had, which is the shader's default.
 *
 * Both of the first two are stated with the parameter names, because the fix is
 * always either to re-capture the preset or to put the range back, and which one
 * depends on which parameters moved.
 *
 * THE THIRD ONE IS WHY THIS PARAGRAPH EXISTS. Adding a parameter to a piece
 * silently redefines every preset it already has, and the damage is not that the
 * new parameter is missing — it is that the preset now means something
 * different. 010 is the case that found it: adding a flow drift, defaulted on,
 * turned two presets that captured `uDecay = 1` from "accumulate this one map
 * forever" into "accumulate every map the drift passes through", which is a
 * smear. Nothing would have reported that; the presets would simply have
 * started rendering a different, worse picture.
 *
 * Measured before it was made fatal: every preset in the gallery named every
 * parameter its piece declared, except the two that had just been invalidated.
 * So the refusal costs nothing today and catches exactly this drift, and
 * `tools/capture.ts` makes recapturing one command.
 */
export async function applyPreset(page: Page, preset: Preset, where: string): Promise<void> {
  const miss = await page.evaluate(
    (values: Record<string, unknown>) => window.__pa.loadValues(values),
    preset.values,
  );

  const declared = await page.evaluate(
    () => window.__pa.store.specs.map((s: { name: string }) => s.name),
  ) as string[];
  const unspecified = declared.filter((n) => !(n in preset.values));

  const problems: string[] = [];
  if (miss.unknown.length) {
    problems.push(`  names the piece does not declare: ${miss.unknown.join(', ')}`);
  }
  if (miss.changed.length) {
    problems.push(`  values that did not survive the parameter's range: ${miss.changed.join(', ')}`);
  }
  if (unspecified.length) {
    problems.push(
      `  parameters the piece declares that this preset does not name: ${unspecified.join(', ')}\n` +
      '    (they fall back to the shader defaults, so the preset no longer pins one picture)');
  }
  if (problems.length) {
    throw new Error(
      `${where}: preset ${JSON.stringify(preset.name)} does not fit this piece\n` +
        `${problems.join('\n')}\n` +
        `  the preset is stale — re-capture it:  npx tsx tools/capture.ts <id> ${preset.name}`,
    );
  }
}

/**
 * The whole flow, since all four CLIs want exactly the same six lines: pick the
 * name, resolve it, apply it, and say on stdout which look is being rendered.
 *
 * Returns the preset name for the caller's own logging, or null for defaults.
 */
export async function usePreset(
  page: Page,
  meta: PresetMeta,
  flag: string | undefined,
  where: string,
): Promise<string | null> {
  const name = chosenPreset(meta, flag);
  if (!name) return null;
  await applyPreset(page, resolvePreset(meta, name, where), where);
  return name;
}
