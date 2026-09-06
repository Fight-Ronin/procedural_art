/**
 * Building the ffmpeg invocation, kept apart from running it.
 *
 * Two reasons for the split. The argument list is the part that is easy to get
 * subtly wrong — a missing `-pix_fmt yuv420p` produces a file that plays here
 * and shows a black rectangle in QuickTime, and a wrong `-r` produces a video
 * that is the right length and the wrong speed — so it is the part worth
 * testing, and testing it should not mean encoding a video. And when ffmpeg is
 * not installed, the CLI can print the exact command it would have run, which
 * is only possible if building it does not depend on having it.
 */
import { accessSync, constants } from 'node:fs';

export type Codec = 'h264' | 'prores' | 'vp9' | 'gif';

export const CODECS: Record<Codec, { ext: string; note: string }> = {
  h264: { ext: 'mp4', note: 'plays everywhere; 8-bit 4:2:0' },
  prores: { ext: 'mov', note: 'edit-grade 10-bit 4:2:2, large files' },
  vp9: { ext: 'webm', note: 'for the web, slow to encode' },
  gif: { ext: 'gif', note: 'short loops only; 256 colours' },
};

export type Source =
  /** Raw RGBA written to ffmpeg's stdin, one frame after another. */
  | { kind: 'pipe' }
  /** A printf-style path such as `frames/frame-%05d.png`. */
  | { kind: 'frames'; pattern: string; start: number };

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  out: string;
  codec: Codec;
  source: Source;
  /** Quality knob, meaning depends on the codec. Left to the codec default if absent. */
  crf?: number;
}

/**
 * H.264 in 4:2:0 subsamples chroma by two in each direction, so odd dimensions
 * are not encodable. Rounding is done to the RENDER size rather than by
 * cropping afterwards, because a crop would silently produce frames that no
 * longer match a still rendered at the size that was asked for — and matching
 * is the one property the whole sequence path exists to preserve.
 */
export function evenSize(width: number, height: number): [number, number] {
  return [Math.max(2, width - (width % 2)), Math.max(2, height - (height % 2))];
}

export function ffmpegArgs(o: EncodeOptions): string[] {
  const [w, h] = [o.width, o.height];
  if (o.codec !== 'gif' && o.codec !== 'prores' && (w % 2 || h % 2)) {
    throw new Error(`${o.codec} needs even dimensions; got ${w}x${h} (see evenSize)`);
  }

  // -stats writes a carriage-returned progress line to stderr. That is welcome
  // when ffmpeg runs on its own after a render, and it is a mess when it runs
  // CONCURRENTLY with the renderer's own carriage-returned progress line: the
  // two overwrite each other and neither is readable. Frames get stats, a pipe
  // does not.
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (o.source.kind === 'frames') args.push('-stats');

  if (o.source.kind === 'pipe') {
    // The size and rate are not discoverable from raw bytes: they have to be
    // declared, and they have to be declared before -i.
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(o.fps), '-i', '-');
  } else {
    args.push('-framerate', String(o.fps), '-start_number', String(o.source.start),
      '-i', o.source.pattern);
  }
  args.push('-an');

  switch (o.codec) {
    case 'h264':
      args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', String(o.crf ?? 17),
        // Without this the file is 4:4:4 and several players show nothing.
        '-pix_fmt', 'yuv420p',
        // Puts the index at the front so the file streams before it finishes downloading.
        '-movflags', '+faststart');
      break;
    case 'prores':
      // Profile 3 is ProRes 422 HQ: the usual hand-off to an editor.
      args.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le');
      break;
    case 'vp9':
      args.push('-c:v', 'libvpx-vp9', '-crf', String(o.crf ?? 30), '-b:v', '0',
        '-row-mt', '1', '-pix_fmt', 'yuv420p');
      break;
    case 'gif':
      // One shared palette computed from the footage beats the default 216
      // colour web palette by a wide margin on gradient-heavy work, which all
      // of this is. stats_mode=diff weights the palette towards what moves.
      args.push('-filter_complex',
        '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];' +
        '[b][p]paletteuse=dither=bayer:bayer_scale=3');
      break;
  }

  args.push('-r', String(o.fps), o.out);
  return args;
}

/** The command as a person would type it, for when ffmpeg is not installed. */
export function ffmpegCommand(o: EncodeOptions): string {
  const quote = (a: string) => (/[^\w@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
  return `ffmpeg ${ffmpegArgs(o).map(quote).join(' ')}`;
}

/** The ffmpeg binary, or null. PATH is searched by hand to avoid a shell. */
export function findFfmpeg(): string | null {
  if (process.env.PA_FFMPEG) return process.env.PA_FFMPEG;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = `${dir}/ffmpeg`;
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}
