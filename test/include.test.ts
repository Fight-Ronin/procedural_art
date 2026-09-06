/** Flatten -> source map -> error remap. The load-bearing piece. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  IncludeError,
  resolveIncludes,
  type ReadFile,
} from '../visualization/build/include.ts';
import { buildEntrySource, USER_SPEC } from '../visualization/build/preamble.ts';
import { formatShaderError } from '../visualization/build/errors.ts';
import { check, note, section, throwsWith } from './harness.ts';
import { BASICS, ROOT, rel } from './paths.ts';

section('include resolver');

function makeReader(entryFile: string): ReadFile {
  const src = readFileSync(entryFile, 'utf8');
  return (spec, fromFile) => {
    if (spec === USER_SPEC) return { file: rel(entryFile), source: src };
    const candidates = spec.startsWith('.')
      ? [path.resolve(path.dirname(path.resolve(ROOT, fromFile)), spec)]
      : [path.join(BASICS, spec), path.join(ROOT, spec)];
    for (const c of candidates) {
      if (existsSync(c)) return { file: rel(c), source: readFileSync(c, 'utf8') };
    }
    return null;
  };
}

for (const art of ['artwork/001-drift/main.frag', 'artwork/002-vitreous/main.frag']) {
  const entry = path.join(ROOT, art);
  const r = resolveIncludes(buildEntrySource(), '<generated>', makeReader(entry));
  const lines = r.code.split('\n');

  check(`${art}: #version is line 1`, lines[0] === '#version 300 es');
  check(`${art}: map covers every line`, r.map.length === lines.length,
    `${r.map.length} entries vs ${lines.length} lines`);
  check(`${art}: artwork lines are attributed to the artwork file`,
    r.map.some((m) => m.file === art));
  check(`${art}: pulls in transitive basics`, r.deps.includes('basics/hash/hash.glsl'));
  note(`${lines.length} lines from ${r.deps.length} files`);

  const rotDefs = lines.filter((l) => l.includes('mat2 rot2(float a)')).length;
  check(`${art}: #pragma once dedupes a diamond include`, rotDefs === 1,
    `${rotDefs} definitions of rot2`);
}

// Round-trip: find a known line inside a nested basics file, then confirm the
// formatter names the right file and line back.
{
  const entry = path.join(ROOT, 'artwork/001-drift/main.frag');
  const r = resolveIncludes(buildEntrySource(), '<generated>', makeReader(entry));
  const lines = r.code.split('\n');
  const idx = r.map.findIndex(
    (m, i) => m.file === 'basics/noise/fbm.glsl' && lines[i].includes('float nzFbm21('),
  );
  const origin = r.map[idx];
  const pretty = formatShaderError(
    `ERROR: 0:${idx + 1}: 'nzFbm21' : no matching overloaded function found`,
    r.code,
    r.map,
  );
  check('driver line number is rewritten to file:line',
    pretty.includes(`basics/noise/fbm.glsl:${origin.line}`), pretty.split('\n')[0]);
  check('the source index is dropped, not left as 0:', !pretty.includes('0:basics'));
  check('excerpt shows the offending source line', pretty.includes('float nzFbm21('));
}

throwsWith('circular include throws', IncludeError, () =>
  resolveIncludes('#include "a.glsl"', '<t>', (spec) => ({
    file: spec,
    source: spec === 'a.glsl' ? '#include "b.glsl"' : '#include "a.glsl"',
  })));

throwsWith('missing include throws', IncludeError, () =>
  resolveIncludes('#include "nope/missing.glsl"', '<t>', () => null));
