import type { Uniforms } from '../gl/program.ts';
import {
  defaultValue,
  srgbToHex,
  srgbToLinear1,
  type ParamSpec,
  type ParamValue,
} from './schema.ts';

/** JSON-friendly form used by presets in meta.json and by the URL hash. */
export type Snapshot = Record<string, number | number[] | boolean | string>;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class ParamStore {
  specs: ParamSpec[];
  values: Record<string, ParamValue> = {};
  /** Bumped on every change so the render loop knows nothing else. */
  revision = 0;

  constructor(specs: ParamSpec[]) {
    this.specs = specs;
    this.reset();
  }

  private spec(name: string): ParamSpec | undefined {
    return this.specs.find((s) => s.name === name);
  }

  reset(): void {
    this.values = {};
    for (const s of this.specs) this.values[s.name] = defaultValue(s);
    this.revision++;
  }

  get(name: string): ParamValue | undefined {
    return this.values[name];
  }

  set(name: string, value: ParamValue): void {
    const s = this.spec(name);
    if (!s) return;
    this.values[name] = coerce(s, value);
    this.revision++;
  }

  /**
   * Hot reload. A value survives if the parameter still exists, still has the
   * same shape, and is still in range — otherwise every shader edit would
   * throw away whatever you had just dialled in.
   */
  adopt(next: ParamSpec[]): void {
    const old = this.values;
    const oldSpecs = this.specs;
    this.specs = next;
    this.values = {};
    for (const s of next) {
      const prev = old[s.name];
      const prevSpec = oldSpecs.find((o) => o.name === s.name);
      this.values[s.name] =
        prev !== undefined && prevSpec && prevSpec.kind === s.kind && inRange(s, prev)
          ? coerce(s, prev)
          : defaultValue(s);
    }
    this.revision++;
  }

  /** Upload to GL. Colors are declared in sRGB and converted here — the only
   *  place a human-typed colour crosses into the linear pipeline. */
  apply(u: Uniforms): void {
    for (const s of this.specs) {
      const v = this.values[s.name];
      switch (s.kind) {
        case 'float':
          u.float(s.name, v as number);
          break;
        case 'int':
        case 'enum':
          u.int(s.name, Math.round(v as number));
          break;
        case 'toggle':
          u.int(s.name, v ? 1 : 0);
          break;
        case 'color': {
          const c = (v as number[]).map(srgbToLinear1);
          u.vec3(s.name, c[0], c[1], c[2]);
          break;
        }
        case 'vec': {
          const a = v as number[];
          if (s.dims === 2) u.vec2(s.name, a[0], a[1]);
          else if (s.dims === 3) u.vec3(s.name, a[0], a[1], a[2]);
          else u.vec4(s.name, a[0], a[1], a[2], a[3]);
          break;
        }
      }
    }
  }

  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const s of this.specs) {
      const v = this.values[s.name];
      out[s.name] = s.kind === 'color' ? `#${srgbToHex(v as number[])}` : (v as never);
    }
    return out;
  }

  load(snap: Snapshot): void {
    for (const s of this.specs) {
      const raw = snap[s.name];
      if (raw === undefined) continue;
      this.values[s.name] = coerce(s, decodeSnapshot(s, raw));
    }
    this.revision++;
  }

  toHash(): string {
    const parts: string[] = [];
    for (const s of this.specs) {
      const v = this.values[s.name];
      let text: string;
      if (s.kind === 'color') text = srgbToHex(v as number[]);
      else if (s.kind === 'vec') text = (v as number[]).map(short).join(',');
      else if (s.kind === 'toggle') text = v ? '1' : '0';
      else text = short(v as number);
      parts.push(`${s.name}=${text}`);
    }
    return parts.join('&');
  }

  fromHash(hash: string): void {
    const text = hash.replace(/^#/, '');
    if (!text) return;
    for (const pair of text.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = decodeURIComponent(pair.slice(0, eq));
      const raw = decodeURIComponent(pair.slice(eq + 1));
      const s = this.spec(name);
      if (!s) continue;
      this.values[name] = coerce(s, decodeText(s, raw));
    }
    this.revision++;
  }
}

function short(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}

function hexToSrgbLoose(h: string): number[] {
  const s = h.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16) / 255,
    parseInt(s.slice(2, 4), 16) / 255,
    parseInt(s.slice(4, 6), 16) / 255,
  ];
}

function decodeSnapshot(s: ParamSpec, raw: unknown): ParamValue {
  if (s.kind === 'color') {
    return typeof raw === 'string' ? hexToSrgbLoose(raw) : (raw as number[]);
  }
  return raw as ParamValue;
}

function decodeText(s: ParamSpec, raw: string): ParamValue {
  switch (s.kind) {
    case 'color':
      return hexToSrgbLoose(raw);
    case 'toggle':
      return raw === '1' || raw === 'true';
    case 'vec':
      return raw.split(',').map(Number);
    default:
      return Number(raw);
  }
}

function inRange(s: ParamSpec, v: ParamValue): boolean {
  switch (s.kind) {
    case 'float':
    case 'int':
      return typeof v === 'number' && v >= s.min && v <= s.max;
    case 'vec':
      return (
        Array.isArray(v) && v.length === s.dims && v.every((x) => x >= s.min && x <= s.max)
      );
    case 'color':
      return Array.isArray(v) && v.length === 3;
    case 'toggle':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'number' && s.options.some((o) => o.value === v);
  }
}

function coerce(s: ParamSpec, v: ParamValue): ParamValue {
  switch (s.kind) {
    case 'float':
      return clamp(Number(v), s.min, s.max);
    case 'int':
      return Math.round(clamp(Number(v), s.min, s.max));
    case 'vec': {
      const a = Array.isArray(v) ? v : new Array(s.dims).fill(Number(v));
      return Array.from({ length: s.dims }, (_, i) => clamp(Number(a[i] ?? 0), s.min, s.max));
    }
    case 'color': {
      const a = Array.isArray(v) ? v : [0, 0, 0];
      return Array.from({ length: 3 }, (_, i) => clamp(Number(a[i] ?? 0), 0, 1));
    }
    case 'toggle':
      return Boolean(v);
    case 'enum': {
      const n = Math.round(Number(v));
      return s.options.some((o) => o.value === n) ? n : s.options[0].value;
    }
  }
}
