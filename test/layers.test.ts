/**
 * The three-layer boundary, enforced instead of merely written down.
 *
 * `CONTRIBUTING.md` states the rules that keep this repo from rotting as the
 * number of pieces grows — `basics/` is pure, `artwork/` holds no TypeScript,
 * names are prefixed by domain, nothing registers a piece. Every one of them
 * was prose only, which is the weakest form a rule can take: a convention with
 * no check is followed exactly as long as someone remembers it, and the first
 * violation is usually invisible because it compiles and renders correctly.
 *
 * The failure mode is specific and slow. `basics/` reading one uniform makes
 * the library non-portable and the artwork's behaviour depend on something it
 * did not pass in; the *next* such read is then easy to justify by the first.
 * Nothing goes red. The repo simply stops being three layers, some months
 * after it stopped being three layers.
 *
 * All of this is filesystem work, so the suite runs first and costs nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('layers');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'out' || name === 'dist' || name === '.git') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

/**
 * GLSL has no strings, so comments are the only thing that can hide a token.
 * Stripping them is what makes the scans below mean what they say — `basics/`
 * mentions `uniform`, `uTime` and `paSample` in a dozen comments explaining
 * why it never touches them, and a raw grep would report every one of those as
 * a violation and be ignored from then on.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const glsl = walk(path.join(ROOT, 'basics')).filter((f) => f.endsWith('.glsl'));
const sources = new Map(glsl.map((f) => [f, code(readFileSync(f, 'utf8'))]));

// --- basics/ is pure --------------------------------------------------------
{
  const bad: string[] = [];
  for (const [f, src] of sources) {
    for (const [re, what] of [
      [/^\s*uniform\s/m, 'declares a uniform'],
      [/\bsampler[123]D\b|\bsamplerCube\b/, 'names a sampler type'],
      [/\btexture\s*\(|\btexelFetch\s*\(|\btextureSize\s*\(/, 'samples a texture'],
      // viz's own globals. basics/ receiving one as an argument is fine and
      // normal; reading the global is what makes the function impure.
      [/\bu(?:Time|Frame|Seed|FullRes|TileOrigin|Spp|SampleBase|Quality|Mouse|Init|Substeps?|Accum\w*)\b/, 'reads a viz uniform'],
      [/\bpa(?:Sample|Pixel|Rand\w*|Strat|SeedRng|RngState|Wrap|Bilinear|Uv)\b/, 'reads a viz global'],
      [/\bartCoord\s*\(|\bpxSize\s*\(/, 'calls a viz helper'],
      [/\biTime\b|\biResolution\b|\biFrame\b|\biMouse\b/, 'uses a ShaderToy alias'],
    ] as [RegExp, string][]) {
      const m = re.exec(src);
      if (m) bad.push(`${rel(f)} ${what} (${m[0].trim()})`);
    }
  }
  check('basics/ reads no uniform, samples no texture, calls nothing from viz',
    bad.length === 0, bad.join('\n        '));
}

// --- the one sanctioned hole ------------------------------------------------
//
// GLSL has no function pointers, so a marcher cannot be handed the scene it is
// marching; `march.glsl` declares a prototype the artwork defines. That is a
// real hole in the purity rule and the only defensible one, so it is pinned by
// name: a SECOND undefined prototype appearing in basics/ is how the exception
// would quietly become the pattern.
{
  const holes: string[] = [];
  for (const [f, src] of sources) {
    // A prototype is a declaration terminated by `;` rather than a body.
    // Column 0 only. Anything indented is inside a function body, where a
    // multi-line call such as `return vec3(\n ... );` has the same shape.
    for (const m of src.matchAll(/^(\w+)\s+(\w+)\s*\([^;{)]*\)\s*;/gm)) {
      holes.push(`${rel(f)}: ${m[2]}`);
    }
  }
  check('basics/ has exactly one undefined prototype, and it is sceneSdf',
    holes.length === 1 && holes[0] === 'basics/raymarch/march.glsl: sceneSdf',
    holes.length ? holes.join('; ') : 'none found — has the marcher hook moved?');
}

// --- the other hole: screen-space derivatives -------------------------------
//
// `dFdx` and friends are not uniform reads, so the purity scan above does not
// see them — but they are just as impure in the way that matters: the answer
// depends on the three neighbouring fragments, not on the arguments. That is
// unavoidable for antialiasing and indefensible anywhere else, so it is
// confined to one file and pinned here alongside `sceneSdf`. A derivative
// appearing inside a noise or SDF function would make that function's result
// depend on the rasterizer's 2x2 quad, which is how a piece ends up rendering
// differently when a tile boundary happens to land on it.
{
  const bad: string[] = [];
  for (const [f, src] of sources) {
    if (!/\bdFdx\s*\(|\bdFdy\s*\(|\bfwidth\s*\(/.test(src)) continue;
    if (rel(f) !== 'basics/aa/edge.glsl') bad.push(rel(f));
  }
  check('screen-space derivatives appear only in basics/aa/edge.glsl',
    bad.length === 0, bad.join('; '));
}

// --- naming ------------------------------------------------------------------
//
// The prefix is not decoration: `basics/` is flattened into one translation
// unit, so every name in it shares a single global namespace with every other
// name and with the artwork's own. The table is exhaustive on purpose — a
// directory with no rule is a directory where the rule stops.
{
  const PREFIX: Record<string, string[]> = {
    aa: ['aa'],
    color: ['col'],
    core: [], // the unprefixed base: sat, remap, rot2, quintic
    env: ['env'],
    field: ['flow'],
    hash: ['hash'],
    noise: ['nz'],
    optics: ['opt'],
    raymarch: ['rm', 'sceneSdf'],
    sample: ['smp'],
    sdf: ['sd', 'op'],
    shade: ['sh'],
    volume: ['vol'],
  };
  const dirs = readdirSync(path.join(ROOT, 'basics')).sort();
  check('every basics/ directory has a declared name prefix',
    dirs.every((d) => d in PREFIX),
    `basics/: ${dirs.join(' ')}  declared: ${Object.keys(PREFIX).join(' ')}`);

  const bad: string[] = [];
  for (const [f, src] of sources) {
    const dir = path.relative(path.join(ROOT, 'basics'), path.dirname(f));
    const allowed = PREFIX[dir];
    if (!allowed || allowed.length === 0) continue;
    // Top-level definitions only: every one in this repo starts at column 0,
    // and requiring that is what keeps `return max(...)` out of the results.
    const names = [
      ...[...src.matchAll(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[2]),
      // A struct is a type name, so it carries the prefix capitalised.
      ...[...src.matchAll(/^struct\s+(\w+)/gm)].map((m) => m[1]),
      ...[...src.matchAll(/^const\s+\w+\s+([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]),
    ];
    for (const n of names) {
      const ok = allowed.some((p) =>
        n.startsWith(p) ||
        n.startsWith(p.toUpperCase() + '_') ||
        n.startsWith(p[0].toUpperCase() + p.slice(1)));
      if (!ok) bad.push(`${rel(f)}: ${n} (wants ${allowed.join(' or ')})`);
    }
  }
  check('every basics/ name carries its directory prefix', bad.length === 0,
    bad.join('\n        '));
}

// --- includes stay inside basics/ -------------------------------------------
{
  const bad: string[] = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/#include\s+"([^"]+)"/g)) {
      if (m[1].startsWith('../') || m[1].startsWith('/') || m[1].includes('..')) {
        bad.push(`${rel(f)} includes ${m[1]}`);
      }
    }
  }
  check('no basics/ include escapes basics/', bad.length === 0, bad.join('; '));
  note(`${sources.size} files in basics/`);
}

// --- artwork/ is GLSL and JSON ----------------------------------------------
{
  const files = walk(path.join(ROOT, 'artwork'));
  const ALLOWED = new Set(['.glsl', '.frag', '.vert', '.json', '.png', '.md']);
  const bad = files.filter((f) => !ALLOWED.has(path.extname(f))).map(rel);
  check('artwork/ contains only shaders, metadata and images', bad.length === 0,
    bad.join('; ') || `${files.length} files, extensions ${[...ALLOWED].join(' ')}`);
}

// --- viz discovers artwork, it does not import it ---------------------------
//
// The point of discovery was that adding a piece means adding a directory. A
// single static `import ... from '../artwork/...'` is the hand-written registry
// coming back, and it would work perfectly for the one piece that added it.
{
  const ts = walk(path.join(ROOT, 'visualization')).filter((f) => f.endsWith('.ts'));
  const bad: string[] = [];
  for (const f of ts) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
      if (m[1].includes('artwork/')) bad.push(`${rel(f)}: ${m[1]}`);
    }
  }
  check('visualization/ has no static import from artwork/', bad.length === 0,
    bad.join('; ') || `${ts.length} modules checked; glob discovery only`);
}

// --- closures handed to the browser -----------------------------------------
//
// `page.evaluate` does not send a function, it sends the function's SOURCE
// TEXT. The TypeScript loader rewrites named function expressions to call an
// `__name` helper it defines at module scope on the Node side — which does not
// exist in the page. The result is `ReferenceError: __name is not defined`,
// thrown inside the browser, at run time, only on the line that happens to have
// a named helper in it.
//
// This actually happened: `test/render.test.ts` grew a linear-light reduction
// with three named arrows in it, and the whole render suite aborted. 54 checks
// stopped running and the summary reported a smaller total with no other sign.
//
// The rule is therefore mechanical rather than a matter of care: an
// `evaluate` callback declares no named functions. Anything that wants helpers
// is arithmetic on the values that come back, and belongs on the Node side
// where it can be read, shared and tested (`tools/tone.ts`).
{
  const files = [...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'tools'))]
    .filter((f) => f.endsWith('.ts'));
  const NAMED = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:function\b|(?:\([^)]*\)|\w+)\s*(?::[^=;]+)?=>)/g;
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const call of src.matchAll(/\.evaluate\(/g)) {
      // Brace-free span matching: walk to the matching close paren.
      let i = call.index + call[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      const body = src.slice(call.index + call[0].length, i);
      for (const m of body.matchAll(NAMED)) {
        const line = src.slice(0, call.index).split('\n').length +
          body.slice(0, m.index).split('\n').length - 1;
        bad.push(`${rel(f)}:${line} declares ${m[1]} inside evaluate()`);
      }
    }
  }
  check('no evaluate() callback declares a named function (the __name trap)',
    bad.length === 0,
    bad.join('\n        ') || `${files.length} modules scanned`);
}

// --- line endings ------------------------------------------------------------
//
// Not housekeeping. `tools/fingerprint.ts` and the sequence resume guard hash
// raw file BYTES, and Git for Windows converts line endings on checkout by
// default. Without a `.gitattributes` pinning LF, the same commit produces
// different hashes on Windows than on Linux: every `ref.json` would report
// "basics/ has changed" on a fresh clone, and `--resume` would refuse a
// directory it rendered itself. A CRLF committed today is that bug arriving
// later, on someone else's machine, with a misleading message.
{
  const SRC = ['basics', 'visualization', 'tools', 'test', 'artwork'];
  const bad: string[] = [];
  for (const d of SRC) {
    for (const f of walk(path.join(ROOT, d))) {
      if (!/\.(glsl|frag|vert|ts|json|md)$/.test(f)) continue;
      if (readFileSync(f, 'utf8').includes('\r\n')) bad.push(rel(f));
    }
  }
  check('no source file carries CRLF (byte hashes depend on it)',
    bad.length === 0, bad.slice(0, 10).join('; '));

  const attrs = path.join(ROOT, '.gitattributes');
  let pinned = false;
  try {
    pinned = /text\s*=\s*auto|eol\s*=\s*lf/.test(readFileSync(attrs, 'utf8'));
  } catch { /* absent */ }
  check('.gitattributes pins line endings so a clone cannot change them', pinned,
    pinned ? '' : 'missing or does not set eol=lf — see the note above');
}
