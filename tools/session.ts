/**
 * A headless session: the Vite dev server plus a browser page with a live
 * WebGL2 context, driven from Node.
 *
 * Both the test suite and the export CLI need exactly this, and they need it to
 * behave identically — an exporter that renders through a different path than
 * the one the tests verify is an exporter nobody has verified.
 */
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaHook } from '../visualization/hook.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What visualization/main.ts exposes on window for headless driving. */
export type Hook = PaHook;

export interface Session {
  server: ViteDevServer;
  browser: Browser;
  page: Page;
  consoleErrors: string[];
  origin: string;
  open(query: string): Promise<void>;
  /** Open WITHOUT stopping the animation loop, to exercise the live path. */
  openLive(query: string): Promise<void>;
  close(): Promise<void>;
}

export async function launch(port = 5199): Promise<Session> {
  const server = await createServer({ root: ROOT, server: { port }, logLevel: 'warn' });
  await server.listen();

  const browser = await chromium.launch({
    executablePath: process.env.PA_CHROMIUM ?? '/opt/pw-browsers/chromium',
    // SwiftShader: no GPU here, and it is deterministic across machines, which
    // is what a reference-image check needs.
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
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const origin = `http://localhost:${port}`;

  return {
    server,
    browser,
    page,
    consoleErrors,
    origin,
    async open(query: string) {
      await page.goto(`${origin}/${query}`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__pa !== 'undefined', null, {
        timeout: 30000,
      });
      // The animation loop would resize the canvas and step simulations between
      // evaluate() calls; callers drive every draw themselves.
      await page.evaluate(() => window.__pa.stopLoop());
    },
    async openLive(query: string) {
      await page.goto(`${origin}/${query}`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__pa !== 'undefined', null, {
        timeout: 30000,
      });
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}
