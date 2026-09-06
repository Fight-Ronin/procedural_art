/**
 * Parameter declarations live in the artwork shader, as comments on the
 * uniform. That declaration is the single source of truth: the GUI, the URL
 * state, the presets in meta.json and (later) the export CLI flags are all
 * projections of it. Nothing is declared twice.
 *
 *   uniform float uWarp;  // @param 0 .. 3 = 1.2 "domain warp"
 *   uniform int   uOct;   // @param 1 .. 8 = 5 step 1 "octaves"
 *   uniform vec2  uShift; // @param -1 .. 1 = 0,0 "shift"
 *   uniform vec3  uTint;  // @color = #ff8844 "tint"
 *   uniform bool  uLines; // @toggle = true "isolines"
 *   uniform int   uMode;  // @enum 0:soft 1:hard 2:ink "edge mode"
 *
 * Only the artwork's own source is scanned. basics/ declares no uniforms by
 * rule, so this both relies on and quietly enforces that rule.
 *
 * uSeed / uSpp / uQuality are viz built-ins and get GUI rows automatically —
 * an artwork must not redeclare them.
 */

export type ParamSpec =
  | { kind: 'float'; name: string; label: string; min: number; max: number; step: number; def: number }
  | { kind: 'int'; name: string; label: string; min: number; max: number; step: number; def: number }
  | { kind: 'vec'; name: string; label: string; dims: 2 | 3 | 4; min: number; max: number; step: number; def: number[] }
  /** `def` is sRGB in 0..1. Conversion to linear happens at upload time. */
  | { kind: 'color'; name: string; label: string; def: [number, number, number] }
  | { kind: 'toggle'; name: string; label: string; def: boolean }
  | { kind: 'enum'; name: string; label: string; options: { value: number; label: string }[]; def: number };

export type ParamValue = number | number[] | boolean;

/** `uniform sampler2D uState; // @buffer a "chemical field"` */
export interface BufferBinding {
  /** Sampler uniform name in this shader. */
  name: string;
  /** Pass id it reads, as declared in meta.json's `passes`. */
  pass: string;
  label: string;
}

export class ParamParseError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'ParamParseError';
    this.line = line;
  }
}

const DECL =
  /^\s*uniform\s+(bool|int|float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*;\s*\/\/\s*@(\w+)\s*(.*?)\s*$/;

// Matches ANY annotated sampler, so a misspelled or malformed annotation is an
// error rather than an unbound sampler and a black frame with no explanation.
const SAMPLER_DECL =
  /^\s*uniform\s+sampler2D\s+([A-Za-z_]\w*)\s*;\s*\/\/\s*@(\w+)\b\s*(.*?)\s*$/;

const RESERVED = new Set([
  'uFullRes', 'uTileOrigin', 'uTime', 'uFrame', 'uSeed', 'uSpp', 'uSampleBase', 'uQuality',
  'uMouse', 'uAccumTex', 'uAccumEnable', 'uInit', 'uSubstep', 'uSubsteps',
]);

/** `uWarpAmount` -> `warp amount` */
function niceLabel(name: string): string {
  return name
    .replace(/^u(?=[A-Z])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function takeLabel(rest: string, fallback: string): { rest: string; label: string } {
  const m = /^(.*?)\s*"([^"]*)"\s*$/.exec(rest);
  if (!m) return { rest: rest.trim(), label: fallback };
  return { rest: m[1].trim(), label: m[2] };
}

function nums(s: string, line: number): number[] {
  const parts = s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  const out = parts.map((x) => Number(x));
  if (out.some((v) => !Number.isFinite(v))) {
    throw new ParamParseError(`cannot read number list "${s}"`, line);
  }
  return out;
}

function hexToSrgb(hex: string, line: number): [number, number, number] {
  const h = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new ParamParseError(`@color needs #rrggbb, got "${hex}"`, line);
  }
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export function srgbToHex(c: readonly number[]): string {
  const b = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `${b(c[0])}${b(c[1])}${b(c[2])}`;
}

/** Matches basics/color/spaces.glsl exactly. Colors are typed in sRGB, used in linear. */
export function srgbToLinear1(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function parseParams(source: string): ParamSpec[] {
  const specs: ParamSpec[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const [, glslType, name, kind, tailRaw] = m;
    const line = i + 1;

    if (RESERVED.has(name)) {
      throw new ParamParseError(`${name} is a viz built-in and cannot be redeclared`, line);
    }
    if (seen.has(name)) throw new ParamParseError(`duplicate parameter ${name}`, line);
    seen.add(name);

    const { rest, label } = takeLabel(tailRaw, niceLabel(name));

    if (kind === 'color') {
      if (glslType !== 'vec3') throw new ParamParseError('@color requires vec3', line);
      const hm = /^=\s*(#?[0-9a-fA-F]{6})$/.exec(rest);
      if (!hm) throw new ParamParseError('@color syntax: @color = #rrggbb "label"', line);
      specs.push({ kind: 'color', name, label, def: hexToSrgb(hm[1], line) });
      continue;
    }

    if (kind === 'toggle') {
      if (glslType !== 'bool') throw new ParamParseError('@toggle requires bool', line);
      const tm = /^=\s*(true|false)$/.exec(rest);
      if (!tm) throw new ParamParseError('@toggle syntax: @toggle = true "label"', line);
      specs.push({ kind: 'toggle', name, label, def: tm[1] === 'true' });
      continue;
    }

    if (kind === 'enum') {
      if (glslType !== 'int') throw new ParamParseError('@enum requires int', line);
      const opts = [...rest.matchAll(/(-?\d+)\s*:\s*([A-Za-z0-9_-]+)/g)].map((o) => ({
        value: Number(o[1]),
        label: o[2],
      }));
      if (opts.length === 0) {
        throw new ParamParseError('@enum syntax: @enum 0:soft 1:hard "label"', line);
      }
      specs.push({ kind: 'enum', name, label, options: opts, def: opts[0].value });
      continue;
    }

    if (kind !== 'param') {
      throw new ParamParseError(`unknown annotation @${kind}`, line);
    }

    const pm =
      /^(-?[\d.eE+-]+)\s*\.\.\s*(-?[\d.eE+-]+)\s*=\s*([-\d.,eE+\s]+?)(?:\s+step\s+(-?[\d.eE+-]+))?$/.exec(rest);
    if (!pm) {
      throw new ParamParseError('@param syntax: @param <min> .. <max> = <default> [step <s>] "label"', line);
    }
    const min = Number(pm[1]);
    const max = Number(pm[2]);
    const def = nums(pm[3], line);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      throw new ParamParseError(`bad range ${pm[1]} .. ${pm[2]}`, line);
    }

    const isInt = glslType === 'int';
    const step = pm[4] !== undefined ? Number(pm[4]) : isInt ? 1 : (max - min) / 200;

    if (glslType === 'float' || glslType === 'int') {
      if (def.length !== 1) throw new ParamParseError(`${glslType} takes one default value`, line);
      specs.push({ kind: isInt ? 'int' : 'float', name, label, min, max, step, def: def[0] });
      continue;
    }

    const dims = Number(glslType.slice(3)) as 2 | 3 | 4;
    const filled = def.length === 1 ? new Array(dims).fill(def[0]) : def;
    if (filled.length !== dims) {
      throw new ParamParseError(`${glslType} needs ${dims} defaults, got ${def.length}`, line);
    }
    specs.push({ kind: 'vec', name, label, dims, min, max, step, def: filled });
  }

  return specs;
}

/**
 * Buffer bindings, declared the same way parameters are: on the uniform, in the
 * shader that uses it. The pass ids they name are defined in meta.json, which is
 * where the structural side of a piece lives (which files, what resolution, how
 * many substeps).
 */
export function parseBuffers(source: string): BufferBinding[] {
  const out: BufferBinding[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = SAMPLER_DECL.exec(lines[i]);
    if (!m) continue;
    const [, name, kind, tail] = m;
    if (kind !== 'buffer') {
      throw new ParamParseError(`a sampler2D takes @buffer, not @${kind}`, i + 1);
    }
    if (RESERVED.has(name)) {
      throw new ParamParseError(`${name} is a viz built-in and cannot be redeclared`, i + 1);
    }
    if (seen.has(name)) throw new ParamParseError(`duplicate buffer binding ${name}`, i + 1);
    seen.add(name);
    const { rest, label } = takeLabel(tail, niceLabel(name));
    if (!/^[A-Za-z0-9_-]+$/.test(rest)) {
      throw new ParamParseError('@buffer syntax: @buffer <pass-id> "label"', i + 1);
    }
    out.push({ name, pass: rest, label });
  }
  return out;
}

export function defaultValue(spec: ParamSpec): ParamValue {
  switch (spec.kind) {
    case 'color':
      return [...spec.def];
    case 'vec':
      return [...spec.def];
    default:
      return spec.def;
  }
}
