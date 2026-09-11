import { describe, expect, it } from 'vitest';

import { imageSize, ratioLabel } from './image-size';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): number[] => [...value].map((character) => character.charCodeAt(0));

const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const be16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];

function png(width: number, height: number): Uint8Array {
  return bytes(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13),
    ...text('IHDR'),
    ...be32(width),
    ...be32(height),
    8, 6, 0, 0, 0,
  );
}

/** `segments` are pushed before the frame header, as a real encoder would. */
function jpeg(width: number, height: number, segments: number[][] = []): Uint8Array {
  const body: number[] = [];
  for (const segment of segments) body.push(...segment);
  return bytes(
    0xff, 0xd8,
    ...body,
    0xff, 0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  );
}

const exifSegment = (payload = 64): number[] => [
  0xff, 0xe1,
  ...be16(payload + 2),
  ...new Array<number>(payload).fill(0),
];

function riff(chunk: number[]): Uint8Array {
  return bytes(...text('RIFF'), ...be32(chunk.length + 4), ...text('WEBP'), ...chunk);
}

describe('imageSize', () => {
  it('reads a PNG header', () => {
    expect(imageSize(png(1200, 900))).toEqual({ width: 1200, height: 900 });
  });

  it('reads a JPEG frame header that follows metadata segments', () => {
    // The size is not at a fixed offset: an encoder may write any number of
    // segments before the frame, and EXIF from a phone is routinely kilobytes.
    expect(imageSize(jpeg(4032, 3024, [exifSegment(2000), exifSegment(120)]))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it('does not mistake a Huffman table for a frame header', () => {
    // 0xC4 sits inside the start-of-frame range and is not one.
    const huffman = [0xff, 0xc4, ...be16(6), 0, 1, 2, 3];
    expect(imageSize(jpeg(640, 480, [huffman]))).toEqual({ width: 640, height: 480 });
  });

  it('reads a lossy WebP', () => {
    const vp8 = [
      ...text('VP8 '),
      ...be32(20),
      0, 0, 0,
      0x9d, 0x01, 0x2a,
      ...le16(800),
      ...le16(600),
      0, 0, 0, 0, 0, 0,
    ];
    expect(imageSize(riff(vp8))).toEqual({ width: 800, height: 600 });
  });

  it('reads an extended WebP, whose canvas size is stored as size minus one', () => {
    const vp8x = [...text('VP8X'), ...be32(10), 0, 0, 0, 0, ...le24(1919), ...le24(1079)];
    expect(imageSize(riff(vp8x))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a lossless WebP', () => {
    const packed = (1023 & 0x3fff) | ((767 & 0x3fff) << 14);
    const vp8l = [
      ...text('VP8L'),
      ...be32(16),
      0x2f,
      packed & 0xff,
      (packed >>> 8) & 0xff,
      (packed >>> 16) & 0xff,
      (packed >>> 24) & 0xff,
      0, 0, 0, 0, 0, 0, 0,
    ];
    expect(imageSize(riff(vp8l))).toEqual({ width: 1024, height: 768 });
  });

  it('returns null rather than a guess for anything it cannot read', () => {
    expect(imageSize(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9))).toBeNull();
    expect(imageSize(bytes())).toBeNull();
    expect(imageSize(png(0, 0))).toBeNull();
    // A JPEG truncated before its frame header.
    expect(imageSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16))).toBeNull();
  });
});

describe('ratioLabel', () => {
  it('reduces to the smallest whole pair', () => {
    expect(ratioLabel(1200, 900)).toBe('4:3');
    expect(ratioLabel(1920, 1080)).toBe('16:9');
    expect(ratioLabel(1024, 1024)).toBe('1:1');
  });

  it('keeps the raw pair when reducing does not make it readable', () => {
    expect(ratioLabel(1237, 903)).toBe('1237:903');
  });
});
