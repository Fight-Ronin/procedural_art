/**
 * Turn driver shader-compile spew into something you can act on.
 *
 * A raw WebGL log reads:
 *     ERROR: 0:1847: 'sdCircle' : no matching overloaded function found
 * which is useless once basics/ is flattened into thousands of lines.
 * With the source map from include.ts we can print:
 *     basics/sdf/prim2d.glsl:42:  float sdCircle(vec2 p, float r) {
 */

import type { MapEntry } from './include.ts';
import { mapLine } from './include.ts';

/**
 * Line references in driver logs, in the three formats seen in the wild.
 * `prefix` is kept verbatim; the "<source>:<line>" part is replaced wholesale
 * so the meaningless source index (always 0) does not survive.
 */
const PATTERNS: { re: RegExp; prefix: 1 }[] = [
  { re: /((?:ERROR|WARNING):\s*)\d+:(\d+):/g, prefix: 1 }, // ANGLE / WebGL
  { re: /^(\s*)\d+\((\d+)\)\s*:/gm, prefix: 1 }, // NVIDIA desktop GL
  { re: /^(\s*)\d+:(\d+)\(\d+\):/gm, prefix: 1 }, // Mesa
];

export interface FormatOptions {
  /** Lines of context to show either side of the offending line. */
  context?: number;
}

/**
 * Rewrite every "flattened line N" reference in `log` to "file:line", and
 * append a source excerpt for each distinct site.
 */
export function formatShaderError(
  log: string,
  code: string,
  map: MapEntry[],
  opts: FormatOptions = {},
): string {
  const context = opts.context ?? 2;
  const codeLines = code.split('\n');
  const sites = new Set<number>();

  let rewritten = log;
  for (const { re } of PATTERNS) {
    rewritten = rewritten.replace(re, (match, prefix: string, num: string) => {
      const flat = Number(num);
      const origin = mapLine(map, flat);
      if (!origin) return match;
      sites.add(flat);
      return `${prefix}${origin.file}:${origin.line}:`;
    });
  }

  const excerpts: string[] = [];
  for (const flat of [...sites].sort((a, b) => a - b)) {
    const origin = mapLine(map, flat);
    if (!origin) continue;
    const from = Math.max(1, flat - context);
    const to = Math.min(codeLines.length, flat + context);
    const gutter = String(origin.line + (to - flat)).length;

    const block: string[] = [`--- ${origin.file}:${origin.line}`];
    for (let n = from; n <= to; n++) {
      const at = mapLine(map, n);
      const num = String(at ? at.line : n).padStart(gutter, ' ');
      const marker = n === flat ? '>' : ' ';
      block.push(`${marker} ${num} | ${codeLines[n - 1] ?? ''}`);
    }
    excerpts.push(block.join('\n'));
  }

  return excerpts.length ? `${rewritten}\n\n${excerpts.join('\n\n')}` : rewritten;
}

/** Dump the flattened source with per-line origins. For deep debugging. */
export function annotateSource(code: string, map: MapEntry[]): string {
  return code
    .split('\n')
    .map((line, i) => {
      const at = map[i];
      const tag = at ? `${at.file}:${at.line}` : '?';
      return `${String(i + 1).padStart(5, ' ')} ${tag.padEnd(38, ' ')} | ${line}`;
    })
    .join('\n');
}
