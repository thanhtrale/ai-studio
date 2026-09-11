import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  generatedMediaId,
  groupLabel,
  groupMedia,
  groupOf,
  isMediaId,
  mediaKind,
  recordId,
  sanitiseUploadName,
  shortDescription,
  type MediaItem,
} from './library';

const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  name: id.slice(id.lastIndexOf('/') + 1),
  kind: mediaKind(id) ?? 'video',
  group: groupOf(id),
  bytes: 1024,
  modifiedAt: '2026-09-11T10:00:00.000Z',
  ...over,
});

describe('isMediaId', () => {
  it('accepts a file under a known root', () => {
    expect(isMediaId('outputs/2026-09-11/103000-abcd1234.mp4')).toBe(true);
    expect(isMediaId('inputs/frame.png')).toBe(true);
  });

  it('rejects anything outside the two roots', () => {
    expect(isMediaId('models/ltx-2.5-distilled/x.png')).toBe(false);
    expect(isMediaId('cache/x.mp4')).toBe(false);
    expect(isMediaId('frame.png')).toBe(false);
  });

  it('rejects traversal, absolute and UNC forms', () => {
    expect(isMediaId('outputs/../inputs/frame.png')).toBe(false);
    expect(isMediaId('/outputs/a.mp4')).toBe(false);
    expect(isMediaId('outputs\\a.mp4')).toBe(false);
    expect(isMediaId('C:/outputs/a.mp4')).toBe(false);
    expect(isMediaId('outputs/a.mp4\0.txt')).toBe(false);
  });

  it('rejects segments Win32 would resolve to a different file', () => {
    // Trailing dots and spaces are stripped during path resolution, so these name
    // the same file as the plain id while looking like a different one.
    expect(isMediaId('outputs/a.mp4 ')).toBe(false);
    expect(isMediaId('outputs/sub./a.mp4')).toBe(false);
  });

  it('rejects Win32 device names, which resolve to a device at any depth', () => {
    expect(isMediaId('outputs/con.png')).toBe(false);
    expect(isMediaId('outputs/nul/a.mp4')).toBe(false);
    expect(isMediaId('outputs/com1.mp4')).toBe(false);
    expect(isMediaId('outputs/console.png')).toBe(true);
  });

  it('rejects files that are not media', () => {
    expect(isMediaId('outputs/bench/report.json')).toBe(false);
    expect(isMediaId('outputs/a.exe')).toBe(false);
  });
});

describe('groupOf and groupLabel', () => {
  it('groups by the directory a file sits in', () => {
    expect(groupOf('outputs/2026-09-11/a.mp4')).toBe('outputs/2026-09-11');
    expect(groupOf('outputs/bench/a.mp4')).toBe('outputs/bench');
  });

  it('groups files loose in a root under the root itself', () => {
    expect(groupOf('outputs/a.mp4')).toBe('outputs');
    expect(groupOf('inputs/frame.png')).toBe('inputs');
  });

  it('reads date directories as dates and leaves every other name alone', () => {
    expect(groupLabel('outputs/2026-09-11')).toBe('11 Sep 2026');
    expect(groupLabel('outputs/bench')).toBe('bench');
    expect(groupLabel('outputs')).toBe('outputs');
  });
});

describe('generatedMediaId', () => {
  it('files a generation under its local date, named by time and job', () => {
    const at = new Date(2026, 8, 11, 14, 30, 22);
    expect(generatedMediaId('abcd1234-ef56', at)).toBe('outputs/2026-09-11/143022-abcd1234.mp4');
  });

  it('produces an id the library will accept', () => {
    expect(isMediaId(generatedMediaId('abcd1234-ef56', new Date(2026, 0, 2, 3, 4, 5)))).toBe(true);
  });
});

describe('sanitiseUploadName', () => {
  it('keeps only the last path segment', () => {
    expect(sanitiseUploadName('C:\\Users\\me\\Pictures\\Frame 01.PNG')?.name).toBe('frame-01.png');
    expect(sanitiseUploadName('../../etc/passwd.png')?.name).toBe('passwd.png');
  });

  it('collapses everything outside a small character class', () => {
    expect(sanitiseUploadName('a  b_c (1).jpeg')?.name).toBe('a-b-c-1.jpeg');
  });

  it('names a file whose stem sanitises away', () => {
    expect(sanitiseUploadName('___.png')?.name).toBe('upload.png');
  });

  it('renames a stem Win32 would resolve to a device', () => {
    expect(sanitiseUploadName('CON.png')?.name).toBe('upload-con.png');
    expect(sanitiseUploadName('lpt1.jpg')?.name).toBe('upload-lpt1.jpg');
  });

  it('refuses a type the library cannot show', () => {
    expect(sanitiseUploadName('payload.exe')).toBeNull();
    expect(sanitiseUploadName('notes.txt')).toBeNull();
  });

  it('reports the kind alongside the name', () => {
    expect(sanitiseUploadName('clip.mp4')?.kind).toBe('video');
    expect(sanitiseUploadName('shot.webp')?.kind).toBe('image');
  });
});

describe('recordId', () => {
  it('mirrors the media path under the library directory', () => {
    expect(recordId('outputs/2026-09-11/a.mp4')).toBe('library/outputs/2026-09-11/a.mp4.json');
  });
});

describe('groupMedia', () => {
  it('orders folders and their contents newest first', () => {
    const groups = groupMedia([
      item('outputs/2026-09-10/old.mp4', { modifiedAt: '2026-09-10T09:00:00.000Z' }),
      item('outputs/2026-09-11/mid.mp4', { modifiedAt: '2026-09-11T09:00:00.000Z' }),
      item('outputs/2026-09-11/new.mp4', { modifiedAt: '2026-09-11T11:00:00.000Z' }),
    ]);

    expect(groups.map((entry) => entry.group)).toEqual(['outputs/2026-09-11', 'outputs/2026-09-10']);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(['new.mp4', 'mid.mp4']);
  });

  it("prefers a record's own timestamp over the file mtime", () => {
    const groups = groupMedia([
      item('outputs/a/one.mp4', { modifiedAt: '2026-09-01T00:00:00.000Z' }),
      item('outputs/b/two.mp4', {
        modifiedAt: '2026-09-02T00:00:00.000Z',
        // Copied into place later than it was made; the record is the truth.
        meta: { source: 'generated', createdAt: '2026-08-01T00:00:00.000Z' },
      }),
    ]);

    expect(groups.map((entry) => entry.group)).toEqual(['outputs/a', 'outputs/b']);
  });
});

describe('shortDescription', () => {
  it('leads with the size the file actually came out at', () => {
    const described = shortDescription(
      item('outputs/2026-09-11/a.mp4', {
        bytes: 151_128,
        meta: {
          source: 'generated',
          createdAt: '2026-09-11T10:00:00.000Z',
          armId: 'video-ltx25-diffusers',
          output: { width: 960, height: 512, numFrames: 49, fps: 24, seconds: 2.04 },
        },
      }),
    );

    expect(described).toBe('960×512 · 2.0s · 24 fps · 148 KB · ltx25-diffusers');
  });

  it('marks a file the studio has no record of', () => {
    expect(shortDescription(item('outputs/bench/x.mp4', { bytes: 2048 }))).toBe('2.0 KB · untracked');
  });
});

describe('formatBytes', () => {
  it('scales and keeps one decimal until the number is wide enough not to need it', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(151_128)).toBe('148 KB');
    expect(formatBytes(523_454)).toBe('511 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
