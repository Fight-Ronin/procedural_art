/**
 * Capture a named preset into a piece's meta.json, headlessly.
 *
 *   npx tsx tools/capture.ts 005 ribs uFoldScale=-2.6 uIters=10
 *   npx tsx tools/capture.ts 005 ribs uFoldScale=-2.6 --from ribs
 *
 * The viewer has had a capture button since block 8, and that is the right tool
 * when a look was found by dragging sliders. It is the wrong tool for a look
 * found the way the ones in this repo actually get found — by rendering a
 * contact sheet and reading a cell's coordinates off the printed axis mapping.
 * Retyping those numbers into a browser to press a button, or hand-writing the
 * JSON, is where a preset acquires a value nobody chose.
 *
 * WHAT IS WRITTEN IS A FULL SNAPSHOT, not the overrides given on the command
 * line. A preset that stored only its differences would silently change meaning
 * every time a default moved underneath it, which is the same class of failure
 * `applyPreset` exists to refuse — a print that is a different picture with no
 * error. The overrides say what to change; the file records what it rendered.
 *
 * The overrides are applied through the same `loadValues` path the renderers
 * use, so a name the piece does not declare, or a value its range will not
 * hold, fails here rather than at print time.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Preset } from './preset.ts';
import { pieceRefs } from './ref.ts';
import { launch, ROOT } from './session.ts';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.includes('=') && !a.startsWith('--'));
const [id, name] = positional;
const overrides = args.filter((a) => a.includes('=') && !a.startsWith('--'));
const fromIndex = args.indexOf('--from');
const FROM = fromIndex >= 0 ? args[fromIndex + 1] : undefined;

if (!id || !name || !/^\d{3}$/.test(id)) {
  console.error('usage: npx tsx tools/capture.ts <id> <preset-name> [uParam=value ...] [--from existing-preset]');
  process.exit(2);
}

/**
 * `uFoldScale=-2.6` is a number, `uShell=#e8dcc4` is a string.
 *
 * Deliberately not "try Number, fall back to string": that would turn a colour
 * written as `0xe8dcc4` into a float and store a preset that applies cleanly
 * and renders the wrong colour. A leading `#` is the only string form a
 * parameter takes, so anything else that fails to parse is a typo and says so.
 */
function parseValue(param: string, raw: string): unknown {
  if (raw.startsWith('#')) return raw;
  // A vec, as the shader declares it: `uPan=0.015,0.061`. `tools/sheet.ts`
  // cannot do this — it reads a comma list as three values to sweep — and the
  // limitation is noted in two project files; here a comma is unambiguous,
  // because a capture sets one value per parameter rather than a series.
  if (raw.includes(',')) {
    const parts = raw.split(',').map((x) => Number(x.trim()));
    if (parts.some((v) => !Number.isFinite(v))) {
      throw new Error(`${param}=${raw}: not a list of numbers`);
    }
    return parts;
  }
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  throw new Error(`${param}=${raw}: not a number, and not a #rrggbb colour`);
}

const piece = pieceRefs([id])[0];
if (!piece) {
  console.error(`no piece with id ${id}`);
  process.exit(2);
}

const metaPath = path.join(ROOT, piece.dir, 'meta.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
  presets?: Preset[];
  [k: string]: unknown;
};

const s = await launch(5271);
try {
  await s.open(`?p=${id}`);
  const err = await s.page.evaluate(() => window.__pa.error);
  if (err) throw new Error(`${id} failed to compile:\n${err}`);

  // A preset built ON another one, so a variant does not have to restate the
  // base look and drift from it.
  if (FROM) {
    const base = (meta.presets ?? []).find((p) => p.name === FROM);
    if (!base) throw new Error(`--from ${FROM}: this piece has no preset by that name`);
    const miss = await s.page.evaluate(
      (v: Record<string, unknown>) => window.__pa.loadValues(v), base.values);
    if (miss.unknown.length || miss.changed.length) {
      throw new Error(`--from ${FROM} is stale: unknown ${miss.unknown.join(',') || 'none'}, ` +
        `changed ${miss.changed.join(',') || 'none'}`);
    }
  }

  const values: Record<string, unknown> = {};
  for (const o of overrides) {
    const eq = o.indexOf('=');
    values[o.slice(0, eq)] = parseValue(o.slice(0, eq), o.slice(eq + 1));
  }

  if (Object.keys(values).length) {
    const miss = await s.page.evaluate(
      (v: Record<string, unknown>) => window.__pa.loadValues(v), values);
    if (miss.unknown.length) {
      throw new Error(`${id} does not declare: ${miss.unknown.join(', ')}`);
    }
    // Not a warning. A value the range would not hold means the preset about to
    // be written renders something other than what was asked for, and writing
    // it would bake that difference in permanently.
    if (miss.changed.length) {
      throw new Error(
        `${id}: these values did not survive the parameter's range: ${miss.changed.join(', ')}\n` +
        '  widen the @param range in main.frag, or pick a value inside it');
    }
  }

  const snapshot = await s.page.evaluate(() => window.__pa.snapshot());

  const presets = meta.presets ?? [];
  const at = presets.findIndex((p) => p.name === name);
  const preset: Preset = { name, values: snapshot };
  if (at >= 0) presets[at] = preset;
  else presets.push(preset);
  meta.presets = presets;

  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`  ${id}  preset ${JSON.stringify(name)} ` +
    `${at >= 0 ? 'replaced' : 'added'} with ${Object.keys(snapshot).length} values ` +
    `->  ${piece.dir}/meta.json`);
} finally {
  await s.close();
}
