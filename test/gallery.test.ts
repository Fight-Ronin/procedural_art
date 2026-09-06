/**
 * The gallery page.
 *
 * Three things are worth pinning here, and only one of them is "it renders".
 *
 * A card must LINK somewhere that works — a gallery whose links 404 is worse
 * than no gallery. A thumbnail must actually decode — `thumb.png` is committed,
 * and a card showing a broken image is the most embarrassing possible failure
 * for a page whose entire job is showing pictures. And the page must not pull
 * the artwork shaders into its bundle: the gallery is built from `catalog.ts`
 * precisely so it ships no GLSL, and one convenient `import { PIECES }` would
 * undo that silently, with nothing visibly wrong.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { launch, ROOT } from '../tools/session.ts';
import { check, note, section } from './harness.ts';

section('gallery');

const dirs = readdirSync(path.join(ROOT, 'artwork'))
  .filter((d) => /^\d{3}-/.test(d))
  .sort();

const s = await launch(5209);
try {
  // Not `open()`: that waits for window.__pa, which the gallery deliberately
  // does not have — it has no WebGL context and no animation loop at all.
  const requests: string[] = [];
  s.page.on('request', (r) => requests.push(r.url()));
  await s.page.goto(`${s.origin}/gallery.html`, { waitUntil: 'networkidle' });

  const cards = await s.page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a.card')).map((a) => ({
      href: new URL(a.href).search,
      title: a.querySelector('.title')?.textContent ?? '',
      id: a.querySelector('.id')?.textContent ?? '',
      hasImg: !!a.querySelector('img'),
      // naturalWidth is 0 for an image that failed to load, whatever the src
      // says — the only way to know the file is really there and really a PNG.
      decoded: a.querySelector('img')?.naturalWidth ?? 0,
    })),
  );

  check('every artwork directory has a card', cards.length === dirs.length,
    `${cards.length} cards for ${dirs.length} directories: ${dirs.join(', ')}`);

  check('cards are in numbering order',
    cards.map((c) => c.id).join(',') === dirs.map((d) => d.split('-')[0]).join(','),
    cards.map((c) => c.id).join(','));

  check('every card links to its piece in the viewer',
    cards.every((c) => c.href === `?p=${c.id}`),
    cards.map((c) => `${c.id}${c.href}`).join(' '));

  check('every card carries a title', cards.every((c) => c.title.length > 0),
    cards.map((c) => `${c.id} ${c.title}`).join(', '));

  const withThumbs = cards.filter((c) => c.hasImg);
  check('every piece has a committed thumbnail', withThumbs.length === cards.length,
    `${withThumbs.length}/${cards.length} — run: npm run thumbs`);
  check('every thumbnail decodes', withThumbs.every((c) => c.decoded > 0),
    withThumbs.map((c) => `${c.id}:${c.decoded}px`).join(' '));

  // The bundle guard. In dev Vite serves modules unbundled, so importing
  // pieces.ts here would show up as the page fetching every artwork shader.
  const shaderRequests = requests.filter((u) => u.includes('.frag'));
  check('the gallery loads no artwork shaders', shaderRequests.length === 0,
    shaderRequests.length
      ? `${shaderRequests.length} shader requests — something imported pieces.ts`
      : `${requests.length} requests, none of them GLSL`);

  // Follow a link the way a person would, and land in the viewer on that piece.
  const first = cards[0];
  if (first) {
    await s.page.click('a.card');
    await s.page.waitForFunction(() => typeof window.__pa !== 'undefined', null, { timeout: 30000 });
    const landed = await s.page.evaluate(() => ({
      piece: window.__pa.piece, error: window.__pa.error,
    }));
    check(`clicking a card opens that piece in the viewer`,
      landed.piece === first.id && !landed.error,
      `${landed.piece}${landed.error ? `\n        ${landed.error}` : ''}`);
    await s.page.evaluate(() => window.__pa.stopLoop());
  }

  check('no console errors from the gallery', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));
  note(`${cards.length} pieces listed`);
} finally {
  await s.close();
}
