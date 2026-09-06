/**
 * The live animation loop.
 *
 * Every other suite calls `stopLoop()` and drives each draw itself, which means
 * the path the user actually looks at all day — requestAnimationFrame, the
 * frame-advance arithmetic, the per-frame simulation step, the accumulate/reset
 * policy — was not covered by anything. This runs the page as a person would.
 *
 * Assertions are on behaviour that must hold regardless of speed (the clock
 * advances, the picture changes, pausing starts refinement), never on a
 * particular frame rate, so it stays meaningful on a slow software renderer.
 */
import { decodePng } from '../tools/png.ts';
import { launch } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('live loop');

function fromDataUrl(url: string) {
  return decodePng(Buffer.from(url.split(',')[1], 'base64'));
}

function spread(data: Uint8Array): number {
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (data[i + c] < min) min = data[i + c];
      if (data[i + c] > max) max = data[i + c];
    }
  }
  return max - min;
}

function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

const only = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
// 002 is left out on purpose: a full-canvas refractive raymarch per animation
// frame takes seconds on a software renderer, and it exercises no loop
// behaviour that 001 and 003 do not.
const PIECES = (only.length ? only : ['001', '003']).filter((id) => id !== '002');

const s = await launch(5205);
try {
  for (const id of PIECES) {
    await s.openLive(`?p=${id}`);

    const err = await s.page.evaluate(() => window.__pa.error);
    if (!check(`${id} compiles in the live page`, !err, err ?? '')) continue;

    // The loop runs on its own: nothing here asked for a frame.
    await s.page.waitForFunction(() => window.__pa.frame > 3, null, { timeout: 30000 });
    const first = fromDataUrl(await s.page.evaluate(() => window.__pa.dataURL()));
    check(`${id} the animation loop advances the clock`, true,
      `frame ${await s.page.evaluate(() => window.__pa.frame)} without being driven`);
    check(`${id} the canvas is not blank`, spread(first.data) > 30,
      `channel spread ${spread(first.data)}, ${first.width}x${first.height}`);

    // Time moving means the picture moving — for 003 that is the simulation
    // stepping once per frame, for 001 the drift term.
    const at = await s.page.evaluate(() => window.__pa.frame);
    await s.page.waitForFunction((f: number) => window.__pa.frame > f + 30, at, { timeout: 30000 });
    const later = fromDataUrl(await s.page.evaluate(() => window.__pa.dataURL()));
    const moved = meanDiff(first.data, later.data);
    check(`${id} the picture changes as the clock advances`, moved > 0.5,
      `mean channel change ${moved.toFixed(2)} over 30+ frames`);

    // Pausing has to do two things: stop the clock, and start refining.
    await s.page.evaluate(() => window.__pa.setPaused(true));
    const held = await s.page.evaluate(() => window.__pa.frame);
    const grew = await s.page
      .waitForFunction(() => window.__pa.samples >= 4, null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check(`${id} pausing accumulates samples`, grew,
      `${await s.page.evaluate(() => window.__pa.samples)} samples while paused`);
    check(`${id} pausing stops the clock`,
      (await s.page.evaluate(() => window.__pa.frame)) === held);

    // And unpausing has to resume, or "pause" would be a one-way door.
    await s.page.evaluate(() => window.__pa.setPaused(false));
    const resumed = await s.page
      .waitForFunction((f: number) => window.__pa.frame > f, held, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    check(`${id} unpausing resumes the clock`, resumed);
    note(`${id} format ${(await s.page.evaluate(() => window.__pa.glInfo())).format}`);
  }

  check('no console errors from the live loop', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));
} finally {
  await s.close();
}
