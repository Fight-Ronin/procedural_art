/**
 * What a piece IS, and the rules a directory must satisfy to be one.
 *
 * Separate from `pieces.ts` because that file uses `import.meta.glob`, which
 * only Vite understands — so anything living beside it cannot be tested outside
 * a browser. The validation below is pure, and it is the part most worth
 * testing cheaply: it replaces guarantees that hand-written imports used to get
 * from the compiler.
 */
import type { PassSpec } from './graph/chain.ts';
import type { Preset } from './params/gui.ts';
import type { ParamSpec } from './params/schema.ts';

/** The shape the GLSL plugin hands back for a `.frag`. */
type ShaderModule = {
  code: string;
  map: { file: string; line: number }[];
  entry: string;
  kind: 'image' | 'buffer';
  params: ParamSpec[];
  buffers: import('./params/schema.ts').BufferBinding[];
};

export type { ShaderModule };

export interface PassConfig {
  id: string;
  shader: string;
  /** Grid texels on the short side. Absolute, so the piece is size-independent. */
  size?: number;
  substeps?: number;
}

export interface PieceMeta {
  id: string;
  title: string;
  slug?: string;
  date?: string;
  tags?: string[];
  notes?: string;
  presets?: Preset[];
  passes?: PassConfig[];
}

export interface Piece {
  id: string;
  title: string;
  /** Repo-relative directory, e.g. `artwork/003-coalesce`. */
  dir: string;
  shader: ShaderModule;
  meta: PieceMeta;
  passes: PassSpec[];
  /**
   * Union of the parameters declared across the image pass and every buffer
   * pass. A piece's parameters live wherever they are used — feed and kill
   * belong to the simulation, contrast belongs to the display — and the store
   * applies the whole set to every program, skipping names a program does not
   * have. First declaration wins if a name appears twice.
   */
  params: ParamSpec[];
}

/** `<3 digits>-<lowercase slug>`; the id is the prefix, the slug the rest. */
export const DIR_PATTERN = /^\d{3}-[a-z0-9-]+$/;

function mergeParams(mods: ShaderModule[]): ParamSpec[] {
  const out: ParamSpec[] = [];
  const seen = new Set<string>();
  for (const m of mods) {
    for (const spec of m.params) {
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      out.push(spec);
    }
  }
  return out;
}

/**
 * Build one piece from a directory, refusing anything ambiguous.
 *
 * Every throw here replaces a compile error the hand-written imports used to
 * give for free. A piece that half-loads is worse than one that does not load:
 * the id in `meta.json` is what `npm run render -- 003` looks up and what the
 * URL selects, so an id that disagrees with its directory means the CLI and the
 * page can quietly be looking at different artworks.
 */
export function buildPiece(dir: string, rawMeta: unknown, files: Record<string, ShaderModule>): Piece {
  const where = `artwork/${dir}`;
  if (!DIR_PATTERN.test(dir)) {
    throw new Error(`${where}: directory must be named <id>-<slug>, e.g. 004-lattice`);
  }
  const meta = rawMeta as PieceMeta;
  const [dirId, ...slugParts] = dir.split('-');
  const dirSlug = slugParts.join('-');

  if (meta?.id !== dirId) {
    throw new Error(`${where}: meta.json id is ${JSON.stringify(meta?.id)}, expected "${dirId}"`);
  }
  if (meta.slug !== undefined && meta.slug !== dirSlug) {
    throw new Error(`${where}: meta.json slug is ${JSON.stringify(meta.slug)}, expected "${dirSlug}"`);
  }
  if (typeof meta.title !== 'string' || meta.title.length === 0) {
    throw new Error(`${where}: meta.json needs a title`);
  }

  const image = files['main.frag'];
  if (!image) throw new Error(`${where}: no main.frag`);
  if (image.kind !== 'image') {
    throw new Error(`${where}: main.frag is a buffer pass; the image pass must be main.frag`);
  }

  const seen = new Set<string>();
  const passes: PassSpec[] = (meta.passes ?? []).map((pc) => {
    const shader = files[pc.shader];
    if (!shader) {
      throw new Error(
        `${where}: pass "${pc.id}" names ${pc.shader}, which is not in the directory ` +
          `(found: ${Object.keys(files).sort().join(', ')})`,
      );
    }
    if (shader.kind !== 'buffer') {
      throw new Error(`${where}: ${pc.shader} is not a buffer pass (name it buffer-*.frag)`);
    }
    if (seen.has(pc.id)) throw new Error(`${where}: two passes share the id "${pc.id}"`);
    seen.add(pc.id);
    return { id: pc.id, shader, size: pc.size ?? 512, substeps: pc.substeps ?? 1 };
  });

  return {
    id: meta.id,
    title: meta.title,
    dir: where,
    shader: image,
    meta,
    passes,
    params: mergeParams([image, ...passes.map((p) => p.shader as ShaderModule)]),
  };
}
