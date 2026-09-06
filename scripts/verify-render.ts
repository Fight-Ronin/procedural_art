/**
 * End-to-end check in a real WebGL2 context:
 *   1. the flattened shader actually compiles on a driver
 *   2. a frame renders and is not blank
 *   3. the resolution-independence contract holds
 *
 * Run: npm run verify:render
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'artwork/001-drift/out');

type Hook = {
  ok: boolean;
  error: string | null;
  store: { specs: { name: string; kind: string }[] };
  renderAt(w: number, h: number, frame: number, spp?: number): number[];
  setParam(name: string, value: number | number[] | boolean): void;
  dataURL(): string;
};
declare global {
  interface Window {
    __pa: Hook;
  }
}

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const server = await createServer({ root, server: { port: 5199 }, logLevel: 'warn' });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PA_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
const consoleErrors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto('http://localhost:5199/', { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__pa !== 'undefined', null, { timeout: 20000 });

const err = await page.evaluate(() => window.__pa.error);
check('shader compiles on a real driver', !err, err ?? '');
if (err) {
  console.log(err);
}

const stats = await page.evaluate(() => {
  const px = window.__pa.renderAt(512, 512, 0, 4);
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = px[i + c];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
  }
  const n = (px.length / 4) * 3;
  return { min, max, mean: sum / n, nan: px.some((v) => Number.isNaN(v)) };
});
check('frame is not blank', stats.max - stats.min > 30, JSON.stringify(stats));
check('no NaN in output', !stats.nan);

// --- resolution independence -------------------------------------------------
// Same frame at 400px and at 1200px, the big one box-downsampled to 400.
// If a shader hardcodes pixel sizes, this diff explodes. This is the check that
// catches "looked fine in preview, fell apart at print size" before it happens.
const diff = await page.evaluate(() => {
  const small = window.__pa.renderAt(400, 400, 0, 1);
  const big = window.__pa.renderAt(1200, 1200, 0, 1);
  const k = 3;
  let sum = 0;
  let max = 0;
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            acc += big[(((y * k + dy) * 1200) + (x * k + dx)) * 4 + c];
          }
        }
        const d = Math.abs(acc / (k * k) - small[(y * 400 + x) * 4 + c]);
        sum += d;
        if (d > max) max = d;
      }
    }
  }
  return { mean: sum / (400 * 400 * 3), max };
});
check('resolution independent (mean channel diff < 8/255)', diff.mean < 8,
  `mean ${diff.mean.toFixed(2)}  max ${diff.max}`);

// --- declared parameters actually reach the GPU ------------------------------
const paramEffect = await page.evaluate(() => {
  const names = window.__pa.store.specs.map((s) => s.name);
  const base = window.__pa.renderAt(256, 256, 0, 1);
  const diffAfter = (fn: () => void) => {
    fn();
    const next = window.__pa.renderAt(256, 256, 0, 1);
    let sum = 0;
    for (let i = 0; i < base.length; i += 4) {
      sum += Math.abs(next[i] - base[i]);
    }
    return sum / (base.length / 4);
  };
  const contours = diffAfter(() => window.__pa.setParam('uContours', false));
  window.__pa.setParam('uContours', true);
  const colour = diffAfter(() => window.__pa.setParam('uHot', [0.1, 0.9, 0.4]));
  window.__pa.setParam('uHot', [0.992, 0.8, 0.47]);
  return { names, contours, colour };
});
check('parameters were parsed from the shader', paramEffect.names.length >= 10,
  paramEffect.names.join(', '));
check('a toggle changes the image', paramEffect.contours > 0.5,
  `mean red delta ${paramEffect.contours.toFixed(2)}`);
check('a colour parameter changes the image', paramEffect.colour > 2,
  `mean red delta ${paramEffect.colour.toFixed(2)}`);

// --- poster ------------------------------------------------------------------
await page.evaluate(() => window.__pa.renderAt(1200, 1200, 0, 16));
const url = await page.evaluate(() => window.__pa.dataURL());
const { mkdirSync } = await import('node:fs');
mkdirSync(OUT, { recursive: true });
const poster = path.join(OUT, 'poster.png');
writeFileSync(poster, Buffer.from(url.split(',')[1], 'base64'));
console.log(`\nwrote ${path.relative(root, poster)}`);

// --- preset capture writes into meta.json ------------------------------------
{
  const metaPath = path.join(root, 'artwork/001-drift/meta.json');
  const before = readFileSync(metaPath, 'utf8');
  const res = await fetch('http://localhost:5199/__pa/preset', {
    method: 'POST',
    body: JSON.stringify({
      entry: 'artwork/001-drift/main.frag',
      name: '__verify__',
      values: { uWarp: 1.23 },
    }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  const after = JSON.parse(readFileSync(metaPath, 'utf8')) as {
    presets: { name: string; values: Record<string, number> }[];
  };
  const saved = after.presets.find((p) => p.name === '__verify__');
  check('capture writes a preset into meta.json',
    json.ok && saved?.values.uWarp === 1.23, json.error ?? JSON.stringify(saved));
  writeFileSync(metaPath, before); // leave the repo as we found it
}

check('no console errors', consoleErrors.length === 0, consoleErrors.join('\n'));

await browser.close();
await server.close();
console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
