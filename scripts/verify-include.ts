/**
 * Verifies the load-bearing piece: flatten -> source map -> error remap.
 * Run: npm run verify:include
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIncludes, IncludeError, type ReadFile } from '../visualization/build/include.ts';
import { buildEntrySource, USER_SPEC } from '../visualization/build/preamble.ts';
import { formatShaderError } from '../visualization/build/errors.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const basics = path.join(root, 'basics');
const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');

function makeReader(entryFile: string): ReadFile {
  const src = readFileSync(entryFile, 'utf8');
  return (spec, fromFile) => {
    if (spec === USER_SPEC) return { file: rel(entryFile), source: src };
    const candidates = spec.startsWith('.')
      ? [path.resolve(path.dirname(path.resolve(root, fromFile)), spec)]
      : [path.join(basics, spec), path.join(root, spec)];
    for (const c of candidates) {
      if (existsSync(c)) return { file: rel(c), source: readFileSync(c, 'utf8') };
    }
    return null;
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

const entry = path.join(root, 'artwork/001-drift/main.frag');
const r = resolveIncludes(buildEntrySource(), '<generated>', makeReader(entry));

check('#version is line 1', r.code.split('\n')[0] === '#version 300 es');
check('map covers every line', r.map.length === r.code.split('\n').length,
  `${r.map.length} entries vs ${r.code.split('\n').length} lines`);
check('artwork lines are attributed to the artwork file',
  r.map.some((m) => m.file === 'artwork/001-drift/main.frag'));
check('deps include a transitive basics file',
  r.deps.includes('basics/hash/hash.glsl'), r.deps.join(', '));

// core/math.glsl is reached from several branches; #pragma once must dedupe it.
const mathDefs = r.code.split('\n').filter((l) => l.includes('mat2 rot2(float a)')).length;
check('#pragma once dedupes a diamond include', mathDefs === 1, `${mathDefs} definitions of rot2`);

// Round-trip: pick a known line in a nested basics file, find its flattened
// index, and confirm the error formatter names the right file:line.
const target = r.map.findIndex(
  (m, i) => m.file === 'basics/noise/fbm.glsl' && r.code.split('\n')[i].includes('float nzFbm21('),
);
const flat = target + 1;
const origin = r.map[target];
const fakeLog = `ERROR: 0:${flat}: 'nzFbm21' : no matching overloaded function found`;
const pretty = formatShaderError(fakeLog, r.code, r.map);
check('driver line number is rewritten to file:line',
  pretty.includes(`basics/noise/fbm.glsl:${origin.line}`),
  pretty.split('\n')[0]);
check('excerpt shows the offending source line', pretty.includes('float nzFbm21('));

// Cycle detection.
try {
  resolveIncludes('#include "a.glsl"', '<t>', (spec) => ({
    file: spec,
    source: spec === 'a.glsl' ? '#include "b.glsl"' : '#include "a.glsl"',
  }));
  check('circular include throws', false);
} catch (e) {
  check('circular include throws', e instanceof IncludeError,
    e instanceof Error ? e.message : String(e));
}

// Missing include.
try {
  resolveIncludes('#include "nope/missing.glsl"', '<t>', () => null);
  check('missing include throws', false);
} catch (e) {
  check('missing include throws', e instanceof IncludeError);
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} failure(s)`} — flattened to ${r.code.split('\n').length} lines from ${r.deps.length} files`);
process.exit(failures === 0 ? 0 : 1);
