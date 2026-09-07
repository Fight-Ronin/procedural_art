/**
 * Frame sequences and video encoding.
 *
 * The headline check is the last one and everything before it is scaffolding:
 * frame N of a stepped sequence must be byte-for-byte the frame a still render
 * produces by seeking to N. Two code paths, one picture. If they ever diverge,
 * the video and the print of "the same moment" are different pictures, and the
 * only way to find out would be to notice by eye.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODECS, evenSize, ffmpegArgs, ffmpegCommand, findFfmpeg } from '../tools/encode.ts';
import { renderStill } from '../tools/export.ts';
import { fingerprint, type Fingerprint } from '../tools/fingerprint.ts';
import { manifestConflicts, type Manifest } from '../tools/manifest.ts';
import { decodePng, encodePng, type Image } from '../tools/png.ts';
import { frameCount, renderSequence } from '../tools/sequence.ts';
import { launch, ROOT } from '../tools/session.ts';
import { pieceRefs } from '../tools/ref.ts';
import { check, note, section, skip, throwsMessage } from './harness.ts';

section('sequence');

// --- pure parts: frame counts and the ffmpeg command -------------------------

check('frame count rounds rather than truncates',
  frameCount(10, 23.976) === 240 && frameCount(12, 60) === 720,
  `10s@23.976 -> ${frameCount(10, 23.976)}, 12s@60 -> ${frameCount(12, 60)}`);
check('a zero-length video is still one frame', frameCount(0, 60) === 1);

check('even size rounds down and never to zero',
  JSON.stringify(evenSize(1081, 1351)) === '[1080,1350]' &&
    JSON.stringify(evenSize(1, 1)) === '[2,2]',
  `${evenSize(1081, 1351)} / ${evenSize(1, 1)}`);

{
  const args = ffmpegArgs({
    width: 640, height: 480, fps: 30, out: '/tmp/x.mp4', codec: 'h264',
    source: { kind: 'pipe' },
  });
  const i = args.indexOf('-i');
  // Raw bytes carry no size or rate; ffmpeg only accepts them declared, and
  // only before -i. Declared after, they silently become OUTPUT options and the
  // input is rejected or misread.
  check('raw input declares size and rate before -i',
    i > 0 && args.indexOf('-s') < i && args.indexOf('-r') < i && args[i + 1] === '-',
    args.join(' '));
  check('h264 output is yuv420p',
    args.includes('-pix_fmt') && args[args.indexOf('-pix_fmt', i) + 1] === 'yuv420p');
  check('the output path is last', args[args.length - 1] === '/tmp/x.mp4');
}

await throwsMessage('odd dimensions are refused for h264 rather than silently cropped',
  () => ffmpegArgs({
    width: 641, height: 480, fps: 30, out: '/tmp/x.mp4', codec: 'h264',
    source: { kind: 'pipe' },
  }),
  'even dimensions');

{
  const args = ffmpegArgs({
    width: 640, height: 480, fps: 24, out: '/tmp/x.mov', codec: 'prores',
    source: { kind: 'frames', pattern: '/tmp/f-%05d.png', start: 12 },
  });
  check('a frame sequence declares its start number',
    args[args.indexOf('-start_number') + 1] === '12' &&
      args[args.indexOf('-i') + 1] === '/tmp/f-%05d.png',
    args.join(' '));
  const cmd = ffmpegCommand({
    width: 640, height: 480, fps: 24, out: '/tmp/a b.mov', codec: 'prores',
    source: { kind: 'frames', pattern: '/tmp/f-%05d.png', start: 0 },
  });
  check('the printed command quotes paths with spaces', cmd.includes("'/tmp/a b.mov'"), cmd);
}

// --- the resume manifest -----------------------------------------------------

{
  const sources: Fingerprint = { basics: 'aaaa', build: 'bbbb', piece: 'cccc' };
  const base: Manifest = {
    piece: '003', width: 288, height: 288, fps: 24, spp: 2, draws: 1, start: 0, sources,
  };
  const conflicts = (over: Partial<Manifest>) => manifestConflicts(base, { ...base, ...over });

  check('a matching manifest resumes', conflicts({}).length === 0);
  check('a changed sample count blocks a resume', conflicts({ spp: 1 }).length === 1,
    conflicts({ spp: 1 }).join('; '));
  // Frame rate is playback, not content: 240 frames are 240 frames whether they
  // are played at 24fps or 60, and refusing to resume over it would be noise.
  check('a changed frame rate does not block a resume', conflicts({ fps: 60 }).length === 0);

  // Each side of the fingerprint blocks a resume, and SAYS WHICH SIDE — the
  // whole reason there are three hashes instead of one.
  for (const [k, word] of [['basics', 'basics/'], ['build', 'preamble'],
                           ['piece', "piece's own"]] as const) {
    const c = conflicts({ sources: { ...sources, [k]: 'ffff' } });
    check(`a changed ${k} hash blocks a resume and names ${k}`,
      c.length === 1 && c[0].includes(word), c.join('; '));
  }

  const a = fingerprint(ROOT, 'artwork/001-drift');
  const b = fingerprint(ROOT, 'artwork/002-vitreous');
  check('the fingerprint is stable, and shares basics/ across pieces',
    JSON.stringify(a) === JSON.stringify(fingerprint(ROOT, 'artwork/001-drift')) &&
      a.basics === b.basics && a.build === b.build && a.piece !== b.piece,
    `001 ${JSON.stringify(a)}\n        002 ${JSON.stringify(b)}`);
}

check('every codec declares a container extension',
  Object.values(CODECS).every((c) => /^[a-z0-9]+$/.test(c.ext)),
  Object.entries(CODECS).map(([k, v]) => `${k}.${v.ext}`).join(' '));

// --- the invariant, on a real renderer ---------------------------------------

interface SeqCase {
  id: string;
  size: number;
  /** Deliberately not a divisor of `size`: the short last row and column count. */
  tile: number;
  start: number;
  count: number;
  spp: number;
  draws: number;
}

/**
 * THREE PIECES ON PURPOSE, unlike the render and export suites, which cover
 * every piece and used to only look like they did.
 *
 * What is under test here is a mechanism, not an artwork: that rendering a
 * sequence by STEPPING and rendering one frame by SEEKING produce identical
 * bytes. That can only go wrong where something is CARRIED between frames, so
 * the list is one case per kind of carried thing, and a fourth piece of a kind
 * already covered would cost a minute of rendering and prove nothing new. The
 * check below pins that every id still exists, so a rename cannot quietly turn
 * this into fewer cases.
 */
const CASES: SeqCase[] = [
  // 001 is the only piece using fwidth, so it is the one that would show a
  // tiling regression; it is also stateless, which makes stepping and seeking
  // trivially equal and therefore a control for the stateful case below.
  { id: '001', size: 96, tile: 40, start: 3, count: 3, spp: 2, draws: 1 },
  // 003 is the case with something to get wrong: seeking re-derives the field
  // from the seed, stepping carries it forward, and only one of those is what
  // the sequence does.
  { id: '003', size: 96, tile: 40, start: 4, count: 3, spp: 1, draws: 1 },
  // 006 is the only piece with BLOOM — the second thing carried between frames,
  // and the one nothing was checking. The halo is built once per frame and
  // cached, so a cache key that lost the frame would leave a whole video
  // wearing frame 0's glow. Every other suite renders one frame at a time and
  // could never see it.
  //
  // MEASURED WHICH CHECK ACTUALLY CATCHES IT, rather than assuming. Dropping
  // `frame` from the key does NOT fail the step-versus-seek comparison, because
  // both sides of that comparison end up holding the same stale halo. It fails
  // "skipping a frame still advances past it": with a stale key the cache is
  // order-dependent, so the same frame renders differently depending on which
  // frames were rendered before it — which is exactly what a video suffers and
  // a still never shows. Small numbers because it is the slowest piece here.
  { id: '006', size: 64, tile: 26, start: 2, count: 3, spp: 1, draws: 1 },
];

const only = process.argv.slice(2).filter((a) => /^\d{3}$/.test(a));
const ACTIVE = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;

{
  const have = new Set(pieceRefs().map((p) => p.id));
  const ghosts = CASES.filter((c) => !have.has(c.id)).map((c) => c.id);
  check('the sequence cases name real pieces', ghosts.length === 0,
    ghosts.length ? ghosts.join(', ') : `${CASES.map((c) => c.id).join(', ')}`);
}

const s = await launch(5205);
const outDir = path.join(ROOT, 'artwork', 'out', 'seq-check');

try {
  for (const c of ACTIVE) {
    // A violated invariant throws out of the page rather than returning a
    // value — the renderTile guard is deliberately fatal. Contain it per piece
    // so one broken piece reports as a failure instead of taking the rest of
    // the suite (and the ffmpeg checks below) down with it.
    try {
      await runCase(c);
    } catch (e) {
      check(`${c.id} renders a sequence without violating an invariant`, false,
        e instanceof Error ? e.message.split('\n')[0] : String(e));
    }
  }

  await throwsMessage('a negative frame count is refused',
    () => renderSequence(s.page, {
      width: 32, height: 32, tile: 32, draws: 1, spp: 1, start: 0, count: -1,
    }, () => {}),
    'negative');

  check('no console errors during sequence rendering', s.consoleErrors.length === 0,
    s.consoleErrors.join('\n'));

  // --- one real encode, end to end -------------------------------------------

  const ffmpeg = findFfmpeg();
  const c = ACTIVE[0];
  if (!ffmpeg) {
    skip('frames encode to a video', 'ffmpeg not found on PATH');
  } else if (!c) {
    skip('frames encode to a video', 'no piece selected');
  } else {
    try {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const pattern = path.join(outDir, 'frame-%05d.png');
      const fps = 24;
      const N = 8;

      await s.open(`?p=${c.id}`);
      // 64x62: even, non-square, and not a multiple of the tile size — the shape
      // an encoder is most likely to quietly reframe.
      const [w, h] = evenSize(65, 62);
      await renderSequence(
        s.page,
        { width: w, height: h, tile: 40, draws: 1, spp: 1, start: 0, count: N },
        (frame, _i, image) => {
          writeFileSync(path.join(outDir, `frame-${String(frame).padStart(5, '0')}.png`),
            encodePng(image));
        },
      );
      check('the frames land on disk under the pattern the encoder reads',
        readdirSync(outDir).filter((f) => f.endsWith('.png')).length === N);

      const first = decodePng(readFileSync(path.join(outDir, 'frame-00000.png')));
      check('a written frame round-trips at the requested size',
        first.width === w && first.height === h, `${first.width}x${first.height}`);

      const out = path.join(outDir, 'check.mp4');
      execFileSync(ffmpeg, ffmpegArgs({
        width: w, height: h, fps, out, codec: 'h264', source: { kind: 'frames', pattern, start: 0 },
      }), { stdio: 'pipe' });

      const probe = JSON.parse(execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,nb_frames,pix_fmt,avg_frame_rate',
        '-of', 'json', out,
      ], { encoding: 'utf8' })) as {
        streams: { width: number; height: number; nb_frames: string; pix_fmt: string;
                   avg_frame_rate: string }[];
      };
      const v = probe.streams[0];
      check('the encoded video keeps the rendered dimensions',
        v.width === w && v.height === h, `${v.width}x${v.height}`);
      check('the encoded video has every frame and no more',
        Number(v.nb_frames) === N, `${v.nb_frames} frames`);
      check('the encoded video is yuv420p', v.pix_fmt === 'yuv420p', v.pix_fmt);
      check('the encoded frame rate is the one asked for',
        v.avg_frame_rate === `${fps}/1`, v.avg_frame_rate);
      note(`${path.relative(ROOT, out)} — ${N} frames at ${fps}fps, ${w}x${h}`);
    } catch (e) {
      check('frames encode to a video', false,
        e instanceof Error ? e.message.split('\n')[0] : String(e));
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
  await s.close();
}

/** One piece, end to end. Throws if the page refuses to render a frame. */
async function runCase(c: SeqCase): Promise<void> {
  await s.open(`?p=${c.id}`);
  const err = await s.page.evaluate(() => window.__pa.error);
  if (!check(`${c.id} compiles`, !err, err ?? '')) return;

  const opts = {
    width: c.size, height: c.size, tile: c.tile, draws: c.draws, spp: c.spp,
    start: c.start, count: c.count,
  };

  const t0 = Date.now();
  const got: { frame: number; image: Image }[] = [];
  await renderSequence(s.page, opts, (frame, i, image) => {
    check(`${c.id} frame ${frame} arrives at index ${i}`, frame === c.start + i);
    got.push({ frame, image });
  });
  check(`${c.id} the sequence yields every frame once`, got.length === c.count,
    `${got.length} of ${c.count} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // A sequence that renders the same frame N times would satisfy every
  // equality check below, so establish first that time is actually passing.
  let moved = 0;
  for (let i = 1; i < got.length; i++) {
    if (Buffer.compare(Buffer.from(got[i].image.data), Buffer.from(got[i - 1].image.data)) !== 0) {
      moved++;
    }
  }
  check(`${c.id} consecutive frames differ`, moved === got.length - 1,
    `${moved} of ${got.length - 1} transitions changed the image`);

  // THE invariant.
  let worstFrame = -1;
  let worstBytes = 0;
  for (const { frame, image } of got) {
    const still = await renderStill(s.page, { ...opts, frame });
    let diff = 0;
    const a = Buffer.from(image.data);
    const b = Buffer.from(still.data);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    if (diff > worstBytes) {
      worstBytes = diff;
      worstFrame = frame;
    }
  }
  check(
    `${c.id} a stepped sequence frame is bit-identical to a seeked still`,
    worstBytes === 0,
    worstBytes === 0
      ? `${got.length} frames, ${c.size}px in ${c.tile}px tiles`
      : `frame ${worstFrame}: ${worstBytes} bytes differ`,
  );

  // Skipping a frame must step past it, not stand still: this is the resume
  // path, and a resume that fails to advance the simulation would write
  // frame 500's picture into frames 500..1800 without any error.
  await s.open(`?p=${c.id}`);
  const resumed: { frame: number; image: Image }[] = [];
  await renderSequence(
    s.page,
    { ...opts, shouldRender: (_f, i) => i > 0 },
    (frame, _i, image) => {
      resumed.push({ frame, image });
    },
  );
  const tail = got.slice(1);
  const same = resumed.length === tail.length &&
    resumed.every((r, i) =>
      r.frame === tail[i].frame &&
      Buffer.compare(Buffer.from(r.image.data), Buffer.from(tail[i].image.data)) === 0);
  check(`${c.id} skipping a frame still advances the simulation past it`, same,
    `${resumed.length} rendered of ${c.count}`);
}
