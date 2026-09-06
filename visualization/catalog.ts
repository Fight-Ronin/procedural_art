/**
 * Everything about the artworks that is NOT their shaders.
 *
 * Kept apart from `pieces.ts` so the gallery can list every piece — title,
 * date, tags, thumbnail — without pulling a single line of GLSL into its
 * bundle. `pieces.ts` compiles every artwork's flattened shader source into the
 * page, which is exactly right for the viewer and pure weight for an index.
 *
 * Both discover the same directories from the same glob, so there is one
 * definition of what artwork/ contains, not two that can drift.
 */

export interface CatalogEntry {
  id: string;
  /** Directory name, e.g. `003-coalesce`. */
  dir: string;
  title: string;
  date?: string;
  tags?: string[];
  notes?: string;
  /**
   * URL of the committed thumbnail, or null when the piece has none yet.
   * Null is a normal state — a new piece has no thumbnail until `npm run
   * thumbs` renders one — so the gallery says so rather than showing a
   * broken image.
   */
  thumb: string | null;
  /** The parsed meta.json, for whoever needs a field this interface does not name. */
  meta: unknown;
}

const METAS = import.meta.glob<{ default: unknown }>('../artwork/*/meta.json', { eager: true });
// query+import together give the built asset URL rather than the file's bytes,
// so the thumbnail is hashed and copied by the build like any other asset.
const THUMBS = import.meta.glob<string>('../artwork/*/thumb.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** `../artwork/003-coalesce/meta.json` -> `003-coalesce`. */
export function dirOf(key: string): string {
  return key.split('/')[2];
}

export const CATALOG: CatalogEntry[] = Object.entries(METAS)
  .map(([key, mod]) => {
    const dir = dirOf(key);
    const meta = mod.default as {
      id?: string; title?: string; date?: string; tags?: string[]; notes?: string;
    };
    const thumbKey = Object.keys(THUMBS).find((k) => dirOf(k) === dir);
    return {
      id: meta?.id ?? dir.split('-')[0],
      dir,
      title: meta?.title ?? dir,
      date: meta?.date,
      tags: meta?.tags,
      notes: meta?.notes,
      thumb: thumbKey ? THUMBS[thumbKey] : null,
      meta: mod.default,
    };
  })
  // By id, so the gallery reads in the order the pieces were made. Glob key
  // order is not specified by Vite.
  .sort((a, b) => a.id.localeCompare(b.id));

/** The raw meta.json for each directory, for `pieces.ts` to validate and build. */
export const METAS_BY_DIR: Record<string, unknown> = Object.fromEntries(
  Object.entries(METAS).map(([key, mod]) => [dirOf(key), mod.default]),
);
