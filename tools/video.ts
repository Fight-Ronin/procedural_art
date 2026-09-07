/**
 * Frame sequence and video export CLI.
 *
 *   npm run video -- 003                      # meta's video block, encoded
 *   npm run video -- 001 --seconds 4 --pipe   # quick look, nothing kept on disk
 *   npm run video -- 003 --no-encode          # frames only, encode later
 *   npm run video -- 003 --resume             # pick up an interrupted run
 *
 * Frames are the primary artifact and the video is derived from them. A long
 * render is measured in hours, and a run that keeps only a video stream has
 * nothing to show for itself if it dies at frame 900 of 1800 — whereas 900 PNGs
 * are 900 PNGs, and `--resume` finishes the job. `--pipe` is the exception, for
 * short previews where the frames are not worth keeping.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODECS, ffmpegArgs, ffmpegCommand, evenSize, findFfmpeg, type Codec, type EncodeOptions }
  from './encode.ts';
import { fingerprint } from './fingerprint.ts';
import { manifestConflicts, type Manifest } from './manifest.ts';
import { chosenPreset, usePreset } from './preset.ts';
import { encodePng, type Image } from './png.ts';
import { frameCount, renderSequence } from './sequence.ts';
import { launch, ROOT } from './session.ts';

interface Meta {
  slug?: string;
  video?: { seconds?: number; fps?: number; width?: number; height?: number };
  still?: { width?: number; height?: number };
  passes?: unknown[];
  preset?: string;
  presets?: { name: string; values: Record<string, unknown> }[];
}

const USAGE =
  'usage: video <piece-id> [--width N] [--height N] [--fps N] [--seconds N]\n' +
  '                        [--start N] [--frames N] [--spp N] [--draws N] [--tile N]\n' +
  `                        [--codec ${Object.keys(CODECS).join('|')}] [--crf N]\n` +
  '                        [--preset name] [--pipe] [--no-encode] [--resume] [--out path]';

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string | undefined> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) positional.push(a);
  else if (a === '--pipe' || a === '--no-encode' || a === '--resume') flags[a.slice(2)] = 'true';
  else flags[a.slice(2)] = argv[++i];
}
if (positional.length !== 1) throw new Error(USAGE);

const piece = positional[0];
const dirName = readdirSync(path.join(ROOT, 'artwork'))
  .find((d) => d.startsWith(`${piece}-`));
if (!dirName) throw new Error(`no artwork directory for piece ${piece}`);
const dir = path.join('artwork', dirName);
const meta = JSON.parse(readFileSync(path.join(ROOT, dir, 'meta.json'), 'utf8')) as Meta;

const num = (name: string, fallback: number) =>
  flags[name] !== undefined ? Number(flags[name]) : fallback;

const codec = (flags.codec ?? 'h264') as Codec;
if (!CODECS[codec]) throw new Error(`unknown codec ${codec}; one of ${Object.keys(CODECS).join(', ')}`);

const fps = num('fps', meta.video?.fps ?? 60);
const seconds = num('seconds', meta.video?.seconds ?? 10);

/**
 * Default frame size follows the piece's declared STILL aspect, at a 1080-pixel
 * short side. The artwork's composition is a property of the artwork; a video
 * export that silently reframes a 4:5 piece to 16:9 would be cropping someone's
 * picture to fit a container.
 */
const aspect = (meta.still?.width ?? 1) / (meta.still?.height ?? 1);
const defaultShort = 1080;
const [defW, defH] = aspect >= 1
  ? [Math.round(defaultShort * aspect), defaultShort]
  : [defaultShort, Math.round(defaultShort / aspect)];

const asked: [number, number] = [
  num('width', meta.video?.width ?? defW),
  num('height', meta.video?.height ?? defH),
];
const [width, height] = evenSize(asked[0], asked[1]);

const start = num('start', 0);
const frames = num('frames', frameCount(seconds, fps));
const spp = num('spp', 2);
const draws = num('draws', 1);
const tile = num('tile', 1024);
const crf = flags.crf !== undefined ? Number(flags.crf) : undefined;

const pipe = flags.pipe === 'true';
const encode = flags['no-encode'] !== 'true';
const resume = flags.resume === 'true';
if (pipe && resume) throw new Error('--resume needs frames on disk; drop --pipe');
if (pipe && !encode) throw new Error('--pipe with --no-encode would render to nowhere');

const outDir = path.join(ROOT, dir, 'out');
const slug = meta.slug ?? dirName.replace(/^\d+-/, '');
// The preset is part of a frame directory's identity, not just its manifest.
// Two looks rendered at the same size would otherwise share a directory, and
// the second run would refuse to resume into the first's frames rather than
// simply keeping them apart.
const chosen = chosenPreset(meta, flags.preset);
const tag = chosen ? `-${chosen.replace(/[^\w-]+/g, '_')}` : '';
const framesDir = path.join(outDir, `frames-${width}x${height}${tag}`);
const pattern = path.join(framesDir, 'frame-%05d.png');
const framePath = (n: number) => path.join(framesDir, `frame-${String(n).padStart(5, '0')}.png`);
const videoOut = flags.out
  ? path.resolve(ROOT, flags.out)
  : path.join(outDir, `${slug}-${width}x${height}${tag}-${fps}fps.${CODECS[codec].ext}`);

const manifest: Manifest = {
  piece, width, height, fps, spp, draws, start,
  preset: chosen,
  sources: fingerprint(ROOT, dir),
};
const manifestPath = path.join(framesDir, 'render.json');

const encodeOpts: EncodeOptions = {
  width, height, fps, out: videoOut, codec, crf,
  source: pipe ? { kind: 'pipe' } : { kind: 'frames', pattern, start },
};

// ---------------------------------------------------------------------------

const ffmpeg = findFfmpeg();
if (encode && !ffmpeg) {
  if (pipe) throw new Error('--pipe needs ffmpeg on PATH (or PA_FFMPEG); it was not found');
  process.stdout.write('ffmpeg not found — frames will be written, encode by hand with:\n');
}

if (asked[0] !== width || asked[1] !== height) {
  process.stdout.write(`  size ${asked[0]}x${asked[1]} rounded to ${width}x${height} (even dimensions)\n`);
}
process.stdout.write(
  `${piece}: ${frames} frames from ${start} at ${fps}fps ` +
    `(${(frames / fps).toFixed(1)}s), ${width}x${height}, ` +
    `${draws} x ${spp} = ${draws * spp} samples, ${tile}px tiles\n`,
);

const session = await launch(5215);
let child: ReturnType<typeof spawn> | null = null;
let written = 0;
let skipped = 0;

try {
  await session.open(`?p=${piece}`);
  const err = await session.page.evaluate(() => window.__pa.error);
  if (err) throw new Error(`shader failed to compile:\n${err}`);
  // Before any frame is rendered, and before the frames directory is touched:
  // a stale preset must stop the run, not corrupt a resumable directory.
  await usePreset(session.page, meta, flags.preset, `video ${piece}`);

  // The video's own directory, whichever mode we are in: in --pipe mode ffmpeg
  // opens the output itself and fails with nothing but "No such file or
  // directory" on its stderr if the parent is missing.
  mkdirSync(path.dirname(videoOut), { recursive: true });

  if (pipe) {
    child = spawn(ffmpeg as string, ffmpegArgs(encodeOpts), { stdio: ['pipe', 'inherit', 'inherit'] });
    // Once, not per frame. Attaching it inside writeToChild left one dead
    // listener per frame on the same socket, and Node started warning about a
    // leak at frame 10 of 24 — which on a real render would be frame 10 of 1800.
    child.stdin?.on('error', (e) => {
      throw new Error(`writing to ffmpeg failed: ${e.message}`);
    });
  } else {
    mkdirSync(framesDir, { recursive: true });
    // Only resume into a directory that says what it holds. An unmanifested
    // directory of PNGs is unverifiable — it could be anything, including the
    // same piece at a different sample count — and "probably fine" is not a
    // basis for keeping half the frames of a finished video.
    const hasFrames = readdirSync(framesDir).some((f) => f.endsWith('.png'));
    if (resume && hasFrames) {
      const conflicts = existsSync(manifestPath)
        ? manifestConflicts(manifest, JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest)
        : ['those frames carry no render.json, so what they contain cannot be checked'];
      if (conflicts.length) {
        throw new Error(
          `cannot resume into ${path.relative(ROOT, framesDir)}:\n    ` +
            `${conflicts.join('\n    ')}\n  ` +
            'delete that directory to start over, or render to a different --out.',
        );
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const began = Date.now();
  // The first frame carries the seek — for a stateful piece starting at frame
  // 900 that is 900 simulation steps, and averaging it in makes the estimate
  // wrong by minutes for the rest of the run. Timing restarts after it.
  let steady = began;
  const report = (frame: number, i: number): void => {
    const done = i + 1;
    if (done === 1) steady = Date.now();
    const per = done > 1 ? (Date.now() - steady) / (done - 1) : Date.now() - began;
    const eta = ((frames - done) * per) / 1000;
    process.stdout.write(
      `\r  frame ${done}/${frames} (n=${frame})  ${(per / 1000).toFixed(1)}s/frame  ` +
        `eta ${eta > 90 ? `${(eta / 60).toFixed(1)}m` : `${eta.toFixed(0)}s`}   `,
    );
  };

  const sink = async (frame: number, i: number, image: Image): Promise<void> => {
    if (child) await writeToChild(child, Buffer.from(image.data));
    else writeFileSync(framePath(frame), encodePng(image));
    written++;
    report(frame, i);
  };

  await renderSequence(
    session.page,
    {
      width, height, tile, draws, spp, start, count: frames,
      shouldRender(frame, i) {
        if (!resume || !existsSync(framePath(frame))) return true;
        skipped++;
        report(frame, i);
        return false;
      },
    },
    sink,
  );
  process.stdout.write('\n');

  if (child) {
    child.stdin?.end();
    const code = await new Promise<number>((res) => child?.on('close', (c) => res(c ?? 0)));
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  } else {
    process.stdout.write(
      `  ${written} frames written${skipped ? `, ${skipped} already present` : ''} ` +
        `to ${path.relative(ROOT, framesDir)}\n`,
    );
  }

  if (encode && !pipe) {
    if (!ffmpeg) {
      process.stdout.write(`  ${ffmpegCommand(encodeOpts)}\n`);
    } else {
      const code = await new Promise<number>((res) => {
        const c = spawn(ffmpeg, ffmpegArgs(encodeOpts), { stdio: ['ignore', 'inherit', 'inherit'] });
        c.on('close', (x) => res(x ?? 0));
      });
      if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
    }
  }

  if (encode && ffmpeg) {
    process.stdout.write(`  wrote ${path.relative(ROOT, videoOut)}\n`);
  }
  const mins = (Date.now() - began) / 60000;
  process.stdout.write(`  ${mins < 1 ? `${(mins * 60).toFixed(0)}s` : `${mins.toFixed(1)}m`} total\n`);

  if (session.consoleErrors.length) {
    process.stdout.write(`  console errors:\n    ${session.consoleErrors.join('\n    ')}\n`);
    process.exitCode = 1;
  }
} catch (e) {
  // A CLI failure the user can act on — a resume conflict, a missing ffmpeg, a
  // shader that will not compile — should read as a sentence, not as a stack
  // trace through Node's module loader.
  process.stdout.write(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  child?.stdin?.destroy();
  await session.close();
}

/** Write one frame, waiting for drain — otherwise Node buffers the whole film. */
function writeToChild(c: ReturnType<typeof spawn>, buf: Buffer): Promise<void> {
  return new Promise((res, rej) => {
    const s = c.stdin;
    if (!s || s.destroyed) return rej(new Error('ffmpeg stdin closed early'));
    if (s.write(buf)) res();
    else s.once('drain', res);
  });
}
