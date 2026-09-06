/**
 * Golden reference images.
 *
 * A numbered piece is supposed to be permanent, but `basics/` keeps changing.
 * The reference is what turns "did that fbm tweak alter 001?" from a question
 * nobody asks into a test that answers it. It is a regression detector, not a
 * specification: when it fails, the decision is whether the change was intended,
 * and either the change is reverted or the reference is regenerated on purpose.
 *
 * References are BIT-EXACT, and therefore only valid for the renderer that
 * produced them. Transcendentals differ between drivers, so the same shader on
 * SwiftShader and on a real GPU will not agree to the last bit. Rather than
 * paper over that with a tolerance — which would also hide small real
 * regressions — each reference records the renderer it came from, and the
 * comparison refuses to run against a different one.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { fingerprint, type Fingerprint } from './fingerprint.ts';
import { decodePng, encodePng, type Image } from './png.ts';
import { ROOT } from './session.ts';

export interface RefConfig {
  size: number;
  draws: number;
  spp: number;
  /**
   * Which frame. For a stateful piece this IS how far the simulation has run:
   * frame N means N steps since seeding. One knob, one meaning.
   */
  frame: number;
  seed: number;
}

export interface RefProvenance {
  piece: string;
  config: RefConfig;
  renderer: string;
  glVersion: string;
  format: string;
  generated: string;
  /**
   * What the picture was made from: content hashes of basics/, of the generated
   * preamble, and of the piece's own shaders. Not a gate — a reference never
   * fails because a hash moved — but when the IMAGE fails, this is what turns
   * "something changed" into "basics/ changed".
   */
  sources: Fingerprint;
}

const DEFAULTS: RefConfig = { size: 160, draws: 2, spp: 2, frame: 0, seed: 0 };

export interface PieceRef {
  id: string;
  dir: string;
  config: RefConfig;
  pngPath: string;
  jsonPath: string;
}

/** Every piece in artwork/, with its declared reference settings. */
export function pieceRefs(ids?: string[]): PieceRef[] {
  return readdirSync(path.join(ROOT, 'artwork'))
    .filter((d) => /^\d{3}-/.test(d))
    .map((d) => {
      const dir = path.join('artwork', d);
      const meta = JSON.parse(readFileSync(path.join(ROOT, dir, 'meta.json'), 'utf8')) as {
        id: string;
        ref?: Partial<RefConfig>;
      };
      return {
        id: meta.id,
        dir,
        config: { ...DEFAULTS, ...(meta.ref ?? {}) },
        pngPath: path.join(ROOT, dir, 'ref.png'),
        jsonPath: path.join(ROOT, dir, 'ref.json'),
      };
    })
    .filter((r) => !ids || ids.includes(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function glInfo(page: Page): Promise<{
  renderer: string;
  version: string;
  format: string;
}> {
  const info = await page.evaluate(() => window.__pa.glInfo());
  return {
    renderer: info.unmasked ?? info.renderer,
    version: info.version,
    format: info.format,
  };
}

/**
 * Render a piece exactly as a reference. Deliberately the ordinary accumulation
 * path, not the tiled exporter: this pins the artwork, and the exporter has its
 * own bit-identity test against this same path.
 */
export async function renderReference(page: Page, ref: PieceRef): Promise<Image> {
  const c = ref.config;
  await page.evaluate(
    ({ n, frame, seed }: { n: number; frame: number; seed: number }) => {
      window.__pa.setSeed(seed);
      window.__pa.seekTo(n, n, frame);
    },
    { n: c.size, frame: c.frame, seed: c.seed },
  );
  const bytes = await page.evaluate(
    ({ n, frame, d, spp }: { n: number; frame: number; d: number; spp: number }) =>
      window.__pa.accumulateAt(n, n, frame, d, spp),
    { n: c.size, frame: c.frame, d: c.draws, spp: c.spp },
  );
  return { width: c.size, height: c.size, data: Uint8Array.from(bytes) };
}

export interface Comparison {
  equal: boolean;
  differing: number;
  total: number;
  meanAbs: number;
  maxAbs: number;
  /** Bounding box of changed pixels — tells "one corner" from "everything". */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function compare(a: Image, b: Image): Comparison {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let differing = 0;
  let sum = 0;
  let maxAbs = 0;
  let x0 = a.width;
  let y0 = a.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      let changed = false;
      for (let ch = 0; ch < 4; ch++) {
        const i = (y * a.width + x) * 4 + ch;
        const d = Math.abs(a.data[i] - b.data[i]);
        sum += d;
        if (d > maxAbs) maxAbs = d;
        if (d) changed = true;
      }
      if (changed) {
        differing++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return {
    equal: differing === 0,
    differing,
    total: a.width * a.height,
    meanAbs: sum / (a.width * a.height * 4),
    maxAbs,
    bbox: x1 < 0 ? null : { x0, y0, x1, y1 },
  };
}

/**
 * Reference dimmed to a grey underlay, with differences in red.
 *
 * The amplification is AUTOMATIC, scaled so the largest difference reaches full
 * intensity. A fixed gain is useless in both directions: at a fixed x8, the
 * one-least-significant-bit change that this net is most valuable for catching
 * renders as a black frame, and a large change saturates into a solid blob.
 * The gain is returned so a report can say what the reader is looking at.
 */
export function diffImage(reference: Image, actual: Image): { image: Image; gain: number } {
  let maxAbs = 0;
  for (let i = 0; i < reference.data.length; i++) {
    const d = Math.abs(reference.data[i] - actual.data[i]);
    if (d > maxAbs) maxAbs = d;
  }
  const gain = 255 / Math.max(1, maxAbs);

  const out = new Uint8Array(reference.data.length);
  for (let i = 0; i < reference.data.length; i += 4) {
    const grey = (reference.data[i] + reference.data[i + 1] + reference.data[i + 2]) / 3 * 0.22;
    let d = 0;
    for (let ch = 0; ch < 3; ch++) {
      d = Math.max(d, Math.abs(reference.data[i + ch] - actual.data[i + ch]));
    }
    const hot = Math.min(255, d * gain);
    out[i] = Math.min(255, grey + hot);
    out[i + 1] = grey;
    out[i + 2] = grey;
    out[i + 3] = 255;
  }
  return { image: { width: reference.width, height: reference.height, data: out }, gain };
}

export function readReference(ref: PieceRef): { image: Image; provenance: RefProvenance } | null {
  if (!existsSync(ref.pngPath) || !existsSync(ref.jsonPath)) return null;
  return {
    image: decodePng(readFileSync(ref.pngPath)),
    provenance: JSON.parse(readFileSync(ref.jsonPath, 'utf8')) as RefProvenance,
  };
}

export function writeReference(
  ref: PieceRef,
  image: Image,
  gl: { renderer: string; version: string; format: string },
): void {
  writeFileSync(ref.pngPath, encodePng(image));
  const provenance: RefProvenance = {
    piece: ref.id,
    config: ref.config,
    renderer: gl.renderer,
    glVersion: gl.version,
    format: gl.format,
    generated: new Date().toISOString(),
    sources: fingerprint(ROOT, ref.dir),
  };
  writeFileSync(ref.jsonPath, `${JSON.stringify(provenance, null, 2)}\n`);
}

export function writeDiff(
  ref: PieceRef,
  reference: Image,
  actual: Image,
): { path: string; gain: number } {
  const dir = path.join(ROOT, ref.dir, 'out');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ref-diff.png');
  const { image, gain } = diffImage(reference, actual);
  writeFileSync(file, encodePng(image));
  writeFileSync(path.join(dir, 'ref-actual.png'), encodePng(actual));
  return { path: path.relative(ROOT, file), gain };
}
