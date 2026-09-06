import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { IncludeError, resolveIncludes, type ReadFile } from './build/include.ts';
import { buildEntrySource, RESOLVE_SOURCE, USER_SPEC } from './build/preamble.ts';
import { ParamParseError, parseBuffers, parseParams } from './params/schema.ts';

/**
 * Flattens each artwork .frag (preamble + includes + artwork + epilogue) at
 * build time and ships {code, map, entry} to the browser.
 *
 * Doing it here rather than at runtime means (a) no fs in the browser bundle,
 * and (b) every included .glsl is registered with Vite's watcher, so editing
 * basics/noise/fbm.glsl hot-reloads every artwork that pulls it in.
 */
/** Virtual module exposing viz's own resolve shader, includes already flattened. */
export const RESOLVE_MODULE = 'virtual:pa-resolve';
const RESOLVE_ID = `\0${RESOLVE_MODULE}`;

export function glslPlugin(opts: { root: string }): Plugin {
  const root = path.resolve(opts.root);
  const basicsRoot = path.join(root, 'basics');

  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');

  /** Reader for sources that pull in basics/ but have no artwork of their own. */
  const readBasics: ReadFile = (spec) => {
    const abs = path.join(basicsRoot, spec);
    return existsSync(abs) ? { file: rel(abs), source: readFileSync(abs, 'utf8') } : null;
  };

  return {
    name: 'pa-glsl',
    enforce: 'pre',

    resolveId(id) {
      return id === RESOLVE_MODULE ? RESOLVE_ID : null;
    },

    load(id) {
      if (id !== RESOLVE_ID) return null;
      const r = resolveIncludes(RESOLVE_SOURCE, '<resolve>', readBasics);
      for (const dep of r.deps) {
        if (dep.startsWith('<')) continue;
        const abs = path.resolve(root, dep);
        if (existsSync(abs)) this.addWatchFile(abs);
      }
      return `export default ${JSON.stringify({
        code: r.code,
        map: r.map,
        entry: '<resolve>',
        kind: 'image',
        params: [],
        buffers: [],
      })};`;
    },

    transform(src, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.frag')) return null;

      const read: ReadFile = (spec, fromFile) => {
        if (spec === USER_SPEC) return { file: rel(file), source: src };

        const candidates: string[] = [];
        if (spec.startsWith('.')) {
          const fromAbs = path.resolve(root, fromFile);
          candidates.push(path.resolve(path.dirname(fromAbs), spec));
        } else {
          candidates.push(path.join(basicsRoot, spec));
          candidates.push(path.join(root, spec));
        }
        for (const c of candidates) {
          if (existsSync(c)) return { file: rel(c), source: readFileSync(c, 'utf8') };
        }
        return null;
      };

      // A pass's role is its filename: buffer-*.frag is a simulation step and
      // gets the direct-write epilogue; anything else is the image pass and
      // gets the sampling-and-accumulation one.
      const kind = path.basename(file).startsWith('buffer-') ? 'buffer' : 'image';

      let result;
      try {
        result = resolveIncludes(buildEntrySource(kind), '<generated>', read);
      } catch (e) {
        if (e instanceof IncludeError) {
          this.error(`${e.message}\n  at ${e.file}:${e.line}`);
        }
        throw e;
      }

      for (const dep of result.deps) {
        if (dep.startsWith('<')) continue;
        const abs = path.resolve(root, dep);
        if (existsSync(abs) && abs !== file) this.addWatchFile(abs);
      }

      // Parsed from the artwork's own source, never the flattened tree:
      // basics/ declares no uniforms by rule, and scanning only here keeps it
      // that way.
      let params;
      let buffers;
      try {
        params = parseParams(src);
        buffers = parseBuffers(src);
      } catch (e) {
        if (e instanceof ParamParseError) {
          this.error(`${rel(file)}: ${e.message}`);
        }
        throw e;
      }

      const payload = {
        code: result.code,
        map: result.map,
        entry: rel(file),
        kind,
        params,
        buffers,
      };
      return { code: `export default ${JSON.stringify(payload)};`, map: null };
    },

    /**
     * Dev-only endpoint so "capture" writes a preset straight into the
     * artwork's meta.json. A preset that only lands in the clipboard is a
     * preset you will not paste, and exploration stays lossy.
     */
    configureServer(server) {
      server.middlewares.use('/__pa/preset', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { entry, name, values } = JSON.parse(body) as {
              entry: string;
              name: string;
              values: Record<string, unknown>;
            };
            const metaPath = path.join(path.dirname(path.resolve(root, entry)), 'meta.json');
            if (!existsSync(metaPath)) throw new Error(`no meta.json beside ${entry}`);
            const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
              presets?: { name: string; values: Record<string, unknown> }[];
            };
            meta.presets = meta.presets ?? [];
            const at = meta.presets.findIndex((p) => p.name === name);
            const entryValue = { name, values };
            if (at >= 0) meta.presets[at] = entryValue;
            else meta.presets.push(entryValue);
            writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: rel(metaPath), replaced: at >= 0 }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
        });
      });
    },
  };
}
