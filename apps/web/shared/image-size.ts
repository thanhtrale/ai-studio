/**
 * Pixel dimensions read out of an image's header.
 *
 * Written rather than pulled in because it is a header read, not image
 * processing: the three formats the library accepts each state their size in
 * the first few dozen bytes, and a dependency that decodes pixels to answer
 * that would be the wrong shape of thing entirely.
 *
 * Pure, over a byte range, so the server can hand it the head of a file and the
 * tests can hand it a literal.
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** Enough for a JPEG with a long EXIF block before its first frame header. */
export const HEADER_BYTES = 64 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matches(bytes: Uint8Array, at: number, expected: readonly number[]): boolean {
  if (at + expected.length > bytes.length) return false;
  return expected.every((byte, index) => bytes[at + index] === byte);
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return matches(bytes, at, [...text].map((character) => character.charCodeAt(0)));
}

const u16be = (bytes: Uint8Array, at: number): number => ((bytes[at] as number) << 8) | (bytes[at + 1] as number);

const u32be = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] as number) << 24) |
    ((bytes[at + 1] as number) << 16) |
    ((bytes[at + 2] as number) << 8) |
    (bytes[at + 3] as number)) >>>
  0;

const u16le = (bytes: Uint8Array, at: number): number => (bytes[at] as number) | ((bytes[at + 1] as number) << 8);

const u24le = (bytes: Uint8Array, at: number): number =>
  (bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16);

function pngSize(bytes: Uint8Array): PixelSize | null {
  // The IHDR chunk is mandated to come first, so its position is fixed.
  if (bytes.length < 24 || !ascii(bytes, 12, 'IHDR')) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/**
 * JPEG states its size in a start-of-frame marker, which sits after however
 * many metadata segments the encoder felt like writing -- so this walks the
 * segment chain rather than indexing a fixed offset.
 */
function jpegSize(bytes: Uint8Array): PixelSize | null {
  let at = 2;

  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1; // Fill byte or padding; resynchronise on the next marker.
      continue;
    }

    const marker = bytes[at + 1] as number;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of frame, in any of its flavours. 0xC4, 0xC8 and 0xCC are Huffman
    // and arithmetic tables that share the range and are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }

    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    at += 2 + length;
  }

  return null;
}

function webpSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 30 || !ascii(bytes, 8, 'WEBP')) return null;

  // Extended form: the canvas size is authoritative and stored as size-1.
  if (ascii(bytes, 12, 'VP8X')) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }

  if (ascii(bytes, 12, 'VP8 ')) {
    // The 14-bit dimensions follow the three-byte start code.
    if (!matches(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }

  if (ascii(bytes, 12, 'VP8L')) {
    // 14 bits each, packed across four bytes after the 0x2f signature byte.
    if (bytes[20] !== 0x2f) return null;
    const packed =
      (bytes[21] as number) |
      ((bytes[22] as number) << 8) |
      ((bytes[23] as number) << 16) |
      ((bytes[24] as number) << 24);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }

  return null;
}

/** The size, or null for anything this does not recognise or cannot trust. */
export function imageSize(bytes: Uint8Array): PixelSize | null {
  let size: PixelSize | null = null;

  if (matches(bytes, 0, PNG_SIGNATURE)) size = pngSize(bytes);
  else if (matches(bytes, 0, [0xff, 0xd8])) size = jpegSize(bytes);
  else if (ascii(bytes, 0, 'RIFF')) size = webpSize(bytes);

  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}

/** `1200x900` as `4:3`, for a label. Falls back to the raw pair when it will not reduce. */
export function ratioLabel(width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  const w = width / divisor;
  const h = height / divisor;
  return w <= 64 && h <= 64 ? `${w}:${h}` : `${width}:${height}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) [x, y] = [y, x % y];
  return x || 1;
}
