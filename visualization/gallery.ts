/**
 * The index: every piece in artwork/, as a card linking into the viewer.
 *
 * A separate page rather than a mode of the viewer, because the two want
 * opposite things — the viewer is one canvas filling the window with a GL
 * context and an animation loop, the gallery is a document. Sharing a page
 * would mean one of them carrying the other's machinery for nothing; this way
 * the gallery ships no GLSL and no WebGL at all.
 *
 * Built entirely from `catalog.ts`, so it lists whatever directories exist. A
 * new piece appears here for the same reason it appears in the viewer: it is a
 * directory.
 */
import { CATALOG } from './catalog.ts';

const grid = document.getElementById('grid') as HTMLElement;
const count = document.getElementById('count') as HTMLElement;
const footer = document.getElementById('footer') as HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let missing = 0;

for (const piece of CATALOG) {
  const card = el('a', 'card');
  card.href = `./?p=${piece.id}`;
  card.title = piece.notes ?? '';

  const frame = el('div', 'frame');
  if (piece.thumb) {
    const img = el('img');
    img.src = piece.thumb;
    img.alt = piece.title;
    // Committed thumbnails are the artwork's own aspect, so reserving the box
    // before the image decodes would need a size this page does not know.
    img.loading = 'lazy';
    frame.append(img);
  } else {
    missing++;
    const box = el('div', 'missing');
    box.append(el('div', undefined, 'no thumbnail'), el('div', undefined, `npm run thumbs -- ${piece.id}`));
    frame.append(box);
  }

  const meta = el('div', 'meta');
  meta.append(el('span', 'id', piece.id), el('span', 'title', piece.title));

  const bits = [piece.date, ...(piece.tags ?? [])].filter(Boolean) as string[];
  card.append(frame, meta);
  if (bits.length) card.append(el('div', 'sub', bits.join('  ·  ')));
  grid.append(card);
}

count.textContent = `${CATALOG.length} ${CATALOG.length === 1 ? 'piece' : 'pieces'}`;

footer.append(
  document.createRange().createContextualFragment(
    missing
      ? `${missing} of ${CATALOG.length} have no thumbnail yet — <code>npm run thumbs</code>`
      : 'a piece is a directory under <code>artwork/</code>: <code>meta.json</code> and ' +
        '<code>main.frag</code>, no code to register it',
  ),
);
