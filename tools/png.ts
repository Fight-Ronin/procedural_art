/**
 * Minimal 8-bit RGBA PNG reader and writer, over node:zlib.
 *
 * No dependency, because the alternative is pulling a library into a repo that
 * otherwise has none, and because reading PNGs back is what the reference-image
 * workflow will need: a golden image is only useful if the same code can write
 * it and compare against it.
 *
 * Writes filter type 0 (none) on every scanline. Filtering would shrink the
 * file, but these are noise-like images where it buys little, and an unfiltered
 * stream is trivially verifiable. The reader handles all five filter types, so
 * it can also read PNGs written by anything else.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export interface Image {
  width: number;
  height: number;
  /** RGBA8, top-left origin, length = width * height * 4. */
  data: Uint8Array;
}

/**
 * A 16-bit-per-channel image. Values are 0..65535, RGBA, top-left origin.
 *
 * Separate from `Image` rather than a depth field on it, so that a function
 * taking one cannot silently be handed the other: the two have the same shape
 * and a four-times different byte count, which is the sort of mix-up that
 * produces a plausible quarter of a picture.
 */
export interface Image16 {
  width: number;
  height: number;
  data: Uint16Array;
}

/**
 * 16-bit PNG. Same container, two differences: the depth byte, and samples
 * written BIG-ENDIAN — PNG is big-endian throughout and a typed array on a
 * little-endian machine is not, so the bytes have to be laid out by hand rather
 * than copied.
 *
 * Worth having for print because 8 bits is the deliverable's precision, not the
 * work's: a lab correcting exposure or contrast on an 8-bit file re-quantises
 * what was already quantised and bands it again. The dither in the resolve pass
 * makes 8-bit safe to LOOK at; 16 bits makes it safe to EDIT.
 */
export function encodePng16(img: Image16): Buffer {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} samples, got ${data.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 8; // 4 channels x 2 bytes
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0
    for (let i = 0; i < width * 4; i++) {
      const v = data[y * width * 4 + i];
      raw[rowStart + 1 + i * 2] = (v >> 8) & 0xff;
      raw[rowStart + 2 + i * 2] = v & 0xff;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodePng(img: Image): Buffer {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes, got ${data.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const stored = buf.readUInt32BE(off + 8 + len);
    const actual = crc32(Buffer.concat([buf.subarray(off + 4, off + 8), data]));
    if (stored !== actual) throw new Error(`bad CRC in ${type} chunk`);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      if (data[9] !== 6) throw new Error(`unsupported colour type ${data[9]}`);
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`inflated ${raw.length} bytes, expected ${(stride + 1) * height}`);
  }

  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const x = raw[line + i];
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`unknown filter type ${filter} on row ${y}`);
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, data: out };
}
