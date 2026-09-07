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

/**
 * The display transform, by name. The resolve pass takes the index.
 *
 * One place maps names to numbers, on purpose: the name is what a person types
 * into meta.json and the number is what the shader branches on, and the only
 * way those cannot drift is for exactly one table to exist.
 */
export const PA_TONEMAP = ['none', 'aces', 'reinhard'] as const;
export type TonemapName = (typeof PA_TONEMAP)[number];

export interface BloomConfig {
  /** How much halo to add, in linear light. 0 disables the pass entirely. */
  strength?: number;
  /** Luminance above which a pixel contributes. */
  threshold?: number;
  /**
   * Texels on the short side of the halo buffer — ABSOLUTE, like a simulation
   * grid, which is what keeps a tiled export byte-identical and the halo the
   * same shape at every output size.
   */
  size?: number;
  /** Blur iterations; the stride doubles each one, so reach grows as 2^n. */
  iterations?: number;
}

export interface DisplayConfig {
  /** Default in stops, adjustable afterwards like any parameter. */
  exposure?: number;
  tonemap?: TonemapName;
  bloom?: BloomConfig;
}

/** Structural bloom settings, with the defaults applied. */
export interface BloomSetup {
  size: number;
  iterations: number;
}

export function bloomSetup(d: DisplayConfig | undefined): BloomSetup {
  return { size: d?.bloom?.size ?? 256, iterations: d?.bloom?.iterations ?? 4 };
}

export interface PieceMeta {
  id: string;
  title: string;
  display?: DisplayConfig;
  slug?: string;
  date?: string;
  tags?: string[];
  notes?: string;
  presets?: Preset[];
  /**
   * Which of `presets` the headless renderers use when no `--preset` is passed.
   *
   * One field rather than one per output block: a piece almost always has a
   * single canonical appearance, and having to name it separately in `still`,
   * `poster` and `video` is three chances to update two of them.
   *
   * Deliberately NOT used by `tools/ref.ts`. A reference image is a regression
   * detector for the shader as written, so it stays pinned to the declared
   * defaults; a thumbnail is presentation, so it follows the piece's chosen
   * look. Tying the reference to a preset would mean re-approving every
   * reference whenever a look was re-captured.
   */
  preset?: string;
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

/**
 * Turn the piece's `display` block into two ordinary parameters.
 *
 * They could have been renderer fields read straight from meta.json, and that
 * would have been less code and worse: parameters already get a GUI row, a
 * slot in the URL hash and a slot in a captured preset, and exposure is exactly
 * the sort of thing you find by dragging and then want to keep. Declaring them
 * here rather than in the shader is what lets viz own the transform while the
 * artwork still owns the choice of it.
 *
 * `schema.ts` reserves both names, so an artwork cannot shadow them.
 */
function displayParams(where: string, d: DisplayConfig | undefined): ParamSpec[] {
  const name = d?.tonemap ?? 'aces';
  const index = PA_TONEMAP.indexOf(name);
  if (index < 0) {
    throw new Error(
      `${where}: meta.json display.tonemap is ${JSON.stringify(name)}; ` +
        `expected one of ${PA_TONEMAP.join(', ')}`,
    );
  }
  const exposure = d?.exposure ?? 0;
  if (!Number.isFinite(exposure) || Math.abs(exposure) > 8) {
    throw new Error(`${where}: meta.json display.exposure is ${exposure}; expected -8..8 stops`);
  }
  const bloom = d?.bloom ?? {};
  const strength = bloom.strength ?? 0;
  if (!Number.isFinite(strength) || strength < 0 || strength > 2) {
    throw new Error(`${where}: meta.json display.bloom.strength is ${strength}; expected 0..2`);
  }
  const size = bloom.size ?? 256;
  if (!Number.isInteger(size) || size < 32 || size > 1024) {
    throw new Error(`${where}: meta.json display.bloom.size is ${size}; expected 32..1024 texels`);
  }
  return [
    {
      kind: 'float', name: 'uDisplayExposure', label: 'exposure',
      min: -4, max: 4, step: 0.01, def: exposure,
    },
    // Strength and threshold are parameters for the same reason exposure is:
    // they are found by dragging. Size and iterations are NOT — they change how
    // much buffer is allocated, so they are structural, like a pass grid.
    {
      kind: 'float', name: 'uBloomStrength', label: 'bloom',
      min: 0, max: 1.5, step: 0.005, def: strength,
    },
    {
      kind: 'float', name: 'uBloomThreshold', label: 'bloom threshold',
      min: 0, max: 4, step: 0.01, def: bloom.threshold ?? 1,
    },
    {
      kind: 'enum', name: 'uDisplayTonemap', label: 'tonemap',
      options: PA_TONEMAP.map((n, i) => ({ value: i, label: n })),
      def: index,
    },
  ];
}

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

  // Presets are looked up by name, in the GUI dropdown and by every CLI, so
  // two carrying the same name means one of them can never be selected again —
  // and the one you lose is whichever you captured second, which is the one you
  // just made. Refusing here is what stops a capture from silently shadowing.
  const names = new Set<string>();
  for (const p of meta.presets ?? []) {
    if (typeof p?.name !== 'string' || p.name.length === 0) {
      throw new Error(`${where}: meta.json has a preset with no name`);
    }
    if (names.has(p.name)) {
      throw new Error(`${where}: meta.json has two presets named ${JSON.stringify(p.name)}`);
    }
    names.add(p.name);
  }
  // A piece naming a preset it does not have would render its defaults from
  // every CLI at once, which looks exactly like a piece that declared nothing.
  if (meta.preset !== undefined && !names.has(meta.preset)) {
    throw new Error(
      `${where}: meta.json preset is ${JSON.stringify(meta.preset)}, ` +
        `which is not one of its presets (${[...names].join(', ') || 'none captured yet'})`,
    );
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
    // The artwork's own parameters first, so a piece's controls stay together
    // and the two display rows land at the end of the panel where they belong.
    params: [
      ...mergeParams([image, ...passes.map((p) => p.shader as ShaderModule)]),
      ...displayParams(where, meta.display),
    ],
  };
}
