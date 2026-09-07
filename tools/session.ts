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

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type { Tile } from '../visualization/render/tile.ts';
export type { PaHook as Hook } from '../visualization/hook.ts';

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

  /**
   * Wait for the page's hook, and say what actually went wrong if it never
   * appears.
   *
   * There are two places a shader can fail and they used to report very
   * differently. A GLSL compile error reaches `window.__pa.error` and every
   * tool prints it with the file and line — that path is good. But a failure in
   * the Vite plugin (a bad `#include` path, or a uniform colliding with a viz
   * built-in) happens BEFORE the module loads, so `window.__pa` is never
   * defined at all and the wait simply expired: thirty seconds of nothing
   * followed by `TimeoutError`, with the real message sitting in the server log
   * where a CLI user never looks. Measured while writing 007, which declared a
   * `uFrame` uniform: the refusal was correct, immediate and invisible.
   *
   * Vite reports these by injecting an error overlay into the DOM, so read it.
   */
  async function waitForHook(): Promise<void> {
    try {
      await page.waitForFunction(() => typeof window.__pa !== 'undefined', null, {
        timeout: 30000,
      });
    } catch (e) {
      const overlay = await page
        .evaluate(() => {
          const el = document.querySelector('vite-error-overlay');
          const root = (el as unknown as { shadowRoot?: ShadowRoot } | null)?.shadowRoot;
          return root?.querySelector('.message')?.textContent?.trim() ?? null;
        })
        .catch(() => null);
      if (overlay) throw new Error(`the page failed to build:\n\n${overlay}`);
      if (consoleErrors.length) {
        throw new Error(`the page never initialised:\n  ${consoleErrors.join('\n  ')}`);
      }
      throw e;
    }
  }

  return {
    server,
    browser,
    page,
    consoleErrors,
    origin,
    async open(query: string) {
      await page.goto(`${origin}/${query}`, { waitUntil: 'load' });
      await waitForHook();
      // The animation loop would resize the canvas and step simulations between
      // evaluate() calls; callers drive every draw themselves.
      await page.evaluate(() => window.__pa.stopLoop());
    },
    async openLive(query: string) {
      await page.goto(`${origin}/${query}`, { waitUntil: 'load' });
      await waitForHook();
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}
