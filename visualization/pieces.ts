/**
 * The registry of artworks, discovered rather than declared.
 *
 * This file used to name every piece three times — an import for the image
 * shader, an import for the metadata, an entry in a hand-written array — plus a
 * fourth line per buffer pass. Adding a piece meant editing TypeScript in
 * `visualization/`, which is the one direction of dependency the repo exists to
 * forbid: `artwork/` is supposed to be GLSL and JSON, and adding to it should
 * not require touching the layer below. It also made the friction of a new
 * piece large enough to matter, in a repo whose entire point is having more
 * pieces.
 *
 * Now a piece is a directory. `artwork/<id>-<slug>/` with a `meta.json` and a
 * `main.frag` is a piece; nothing else has to be told. The rules such a
 * directory must satisfy, and the refusals when it does not, live in
 * `piece.ts` so they can be tested without a browser.
 */
import { dirOf, METAS_BY_DIR } from './catalog.ts';
import { buildPiece, type Piece, type ShaderModule } from './piece.ts';

export { buildPiece } from './piece.ts';
export type { PassConfig, Piece, PieceMeta } from './piece.ts';

// eager: the registry is needed to render the first frame, so deferring it would
// only buy an await and a loading state. Vite resolves the glob at build time,
// and .frag still goes through the GLSL plugin exactly as a named import would —
// including the watcher registration that hot-reloads a piece when a basics/
// file it includes is edited. The metadata comes from catalog.ts, so the gallery
// and the viewer discover artwork/ once rather than twice.
const SHADERS = import.meta.glob<{ default: ShaderModule }>('../artwork/*/*.frag', {
  eager: true,
});

function discover(): Piece[] {
  const byDir = new Map<string, { meta?: unknown; files: Record<string, ShaderModule> }>();
  const entry = (dir: string) => {
    let e = byDir.get(dir);
    if (!e) byDir.set(dir, (e = { files: {} }));
    return e;
  };
  for (const [dir, meta] of Object.entries(METAS_BY_DIR)) entry(dir).meta = meta;
  for (const [key, mod] of Object.entries(SHADERS)) {
    entry(dirOf(key)).files[key.split('/').pop() as string] = mod.default;
  }

  const pieces: Piece[] = [];
  for (const [dir, e] of byDir) {
    // A .frag with no meta.json is a work in progress, not an error — but a
    // meta.json with no shaders is a piece that will not load, so let it throw.
    if (e.meta === undefined && Object.keys(e.files).length > 0) continue;
    pieces.push(buildPiece(dir, e.meta, e.files));
  }

  // Sorted by id, so display order is the numbering. Glob key order is not
  // specified, and a registry whose order depends on the filesystem would make
  // "the last piece is the working piece" mean something different per machine.
  pieces.sort((a, b) => a.id.localeCompare(b.id));

  const ids = new Set<string>();
  for (const p of pieces) {
    if (ids.has(p.id)) throw new Error(`two artwork directories claim id ${p.id}`);
    ids.add(p.id);
  }
  if (pieces.length === 0) throw new Error('no pieces found under artwork/');
  return pieces;
}

/** Registry order is display order; the last entry is the working piece. */
export const PIECES: Piece[] = discover();

export function pickPiece(search: string): Piece {
  const want = new URLSearchParams(search).get('p');
  return PIECES.find((p) => p.id === want) ?? PIECES[PIECES.length - 1];
}
