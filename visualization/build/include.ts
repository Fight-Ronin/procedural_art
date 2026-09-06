/**
 * GLSL #include resolver.
 *
 * GLSL has no #include. This flattens a tree of .glsl files into one source
 * string AND emits a source map so that a driver error like
 *
 *     ERROR: 0:1847: 'sdCircle' : no matching overloaded function found
 *
 * can be reported as
 *
 *     basics/sdf/prim2d.glsl:42
 *
 * Without the map, debugging is impossible once basics/ passes a few hundred
 * lines. This is the single most load-bearing file in the repo.
 */

/** Where one line of the flattened output came from. */
export interface MapEntry {
  /** Logical path, e.g. "basics/noise/fbm.glsl" or "<preamble>". */
  file: string;
  /** 1-based line number within that file. */
  line: number;
}

export interface ResolveResult {
  /** Flattened GLSL, ready to hand to glShaderSource. */
  code: string;
  /** map[i] describes line i+1 of `code`. */
  map: MapEntry[];
  /** Every file that was read, for hot-reload invalidation. */
  deps: string[];
}

/**
 * Reads an include target.
 *
 * @param spec      the string inside #include "...".
 * @param fromFile  logical path of the file doing the including.
 * @returns null if not found; the caller turns that into a useful error.
 */
export type ReadFile = (
  spec: string,
  fromFile: string,
) => { file: string; source: string } | null;

const INCLUDE_RE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/;
const PRAGMA_ONCE_RE = /^[ \t]*#pragma[ \t]+once[ \t]*$/;

// NOTE: no TypeScript parameter properties anywhere under visualization/. Plain fields
// keep every module runnable by `node file.ts` under type stripping, with no
// build step — which is what the export CLI will rely on.
export class IncludeError extends Error {
  file: string;
  line: number;
  chain: string[];

  constructor(message: string, file: string, line: number, chain: string[]) {
    super(message);
    this.name = 'IncludeError';
    this.file = file;
    this.line = line;
    this.chain = chain;
  }
}

export function resolveIncludes(
  entrySource: string,
  entryFile: string,
  read: ReadFile,
): ResolveResult {
  const out: string[] = [];
  const map: MapEntry[] = [];
  const deps: string[] = [];
  const included = new Set<string>(); // files that declared #pragma once
  const stack: string[] = []; // for cycle detection + error chains

  function emit(text: string, file: string, line: number) {
    out.push(text);
    map.push({ file, line });
  }

  function walk(source: string, file: string) {
    if (stack.includes(file)) {
      throw new IncludeError(
        `circular include: ${[...stack, file].join(' -> ')}`,
        file,
        1,
        [...stack],
      );
    }
    stack.push(file);
    if (!deps.includes(file)) deps.push(file);

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const lineNo = i + 1;

      if (PRAGMA_ONCE_RE.test(raw)) {
        // Consumed here; mark and drop. Emit a blank so blocks stay readable
        // in the flattened dump without shifting the map (map is explicit).
        included.add(file);
        emit('', file, lineNo);
        continue;
      }

      const m = INCLUDE_RE.exec(raw);
      if (!m) {
        emit(raw, file, lineNo);
        continue;
      }

      const spec = m[1];
      const found = read(spec, file);
      if (!found) {
        throw new IncludeError(
          `cannot resolve #include "${spec}"`,
          file,
          lineNo,
          [...stack],
        );
      }
      if (included.has(found.file)) {
        // Already pulled in and it declared #pragma once.
        emit(`// [include] ${found.file} (already included)`, file, lineNo);
        continue;
      }
      emit(`// [include] >>> ${found.file}`, file, lineNo);
      walk(found.source, found.file);
      emit(`// [include] <<< ${found.file}`, file, lineNo);
    }

    stack.pop();
  }

  walk(entrySource, entryFile);
  return { code: out.join('\n'), map, deps };
}

/** Look up where flattened line `n` (1-based) came from. */
export function mapLine(map: MapEntry[], n: number): MapEntry | null {
  return map[n - 1] ?? null;
}
