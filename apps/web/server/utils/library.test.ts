import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isVideoSettings } from '#shared/library';

import { allocateUploadId, describeMedia, listMedia, mediaPath, readMeta, writeMeta } from './library';
import { RelayError } from './supervisor';

let storage: string;

function put(relative: string, contents = 'x'): void {
  const target = path.join(storage, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

beforeEach(() => {
  storage = mkdtempSync(path.join(tmpdir(), 'ai-studio-library-'));
});

afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe('mediaPath', () => {
  it('resolves an id inside the storage directory', () => {
    expect(mediaPath(storage, 'outputs/a.mp4')).toBe(path.join(storage, 'outputs', 'a.mp4'));
  });

  it('refuses anything that is not a media id', () => {
    for (const bad of ['outputs/../../secret.mp4', 'models/x.png', '/etc/passwd.png', undefined, 42]) {
      expect(() => mediaPath(storage, bad)).toThrow(RelayError);
    }
  });
});

describe('listMedia', () => {
  it('returns nothing when the roots do not exist yet', async () => {
    expect(await listMedia(storage)).toEqual([]);
  });

  it('finds media in both roots and groups it by directory', async () => {
    put('outputs/loose.mp4');
    put('outputs/2026-09-11/143022-abcd1234.mp4');
    put('outputs/bench/run.mp4');
    put('inputs/frame.png');

    const items = await listMedia(storage);

    expect(items.map((item) => item.id).sort()).toEqual([
      'inputs/frame.png',
      'outputs/2026-09-11/143022-abcd1234.mp4',
      'outputs/bench/run.mp4',
      'outputs/loose.mp4',
    ]);
    expect(items.find((item) => item.name === 'run.mp4')?.group).toBe('outputs/bench');
    expect(items.find((item) => item.name === 'loose.mp4')?.group).toBe('outputs');
    expect(items.find((item) => item.name === 'frame.png')?.kind).toBe('image');
  });

  it('ignores files that are not media, and anything outside the two roots', async () => {
    put('outputs/bench/report.json');
    put('outputs/notes.txt');
    put('outputs/.gitkeep', '');
    put('models/ltx/weights.png');
    put('cache/scratch.mp4');

    expect(await listMedia(storage)).toEqual([]);
  });

  it('attaches the record a file has, and lists one it has not', async () => {
    put('outputs/2026-09-11/a.mp4');
    put('outputs/2026-09-11/b.mp4');
    await writeMeta(storage, 'outputs/2026-09-11/a.mp4', {
      source: 'generated',
      createdAt: '2026-09-11T14:30:22.000Z',
      jobId: 'abcd1234',
      armId: 'video-ltx25-diffusers',
      prompt: 'a river at dusk',
    });

    const items = await listMedia(storage);
    const withRecord = items.find((item) => item.name === 'a.mp4');
    const without = items.find((item) => item.name === 'b.mp4');

    expect(withRecord?.meta?.prompt).toBe('a river at dusk');
    expect(withRecord?.meta?.armId).toBe('video-ltx25-diffusers');
    expect(without?.meta).toBeUndefined();
  });

  it('does not walk indefinitely deep', async () => {
    const deep = 'outputs/' + 'a/'.repeat(10);
    put(`${deep}buried.mp4`);
    put('outputs/near/surface.mp4');

    const names = (await listMedia(storage)).map((item) => item.name);

    expect(names).toContain('surface.mp4');
    expect(names).not.toContain('buried.mp4');
  });
});

describe('readMeta', () => {
  it('round-trips a record through a nested path', async () => {
    await writeMeta(storage, 'outputs/2026-09-11/a.mp4', {
      source: 'generated',
      createdAt: '2026-09-11T14:30:22.000Z',
      settings: {
        width: 960,
        height: 544,
        numFrames: 121,
        frameRate: 24,
        seed: 7,
        enhancePrompt: false,
        spatialUpsample: true,
        temporalUpsample: false,
      },
    });

    const meta = await readMeta(storage, 'outputs/2026-09-11/a.mp4');

    expect(meta?.settings?.seed).toBe(7);
    // A record written before there was a second modality carries no `kind`,
    // and still has to read back as the video settings it is.
    expect(isVideoSettings(meta?.settings) && meta?.settings.spatialUpsample).toBe(true);
  });

  it('treats a record it cannot parse as no record at all', async () => {
    put('library/outputs/a.mp4.json', '{ not json');
    put('outputs/a.mp4');

    expect(await readMeta(storage, 'outputs/a.mp4')).toBeUndefined();
    // The file itself is still real, so it still lists.
    expect((await listMedia(storage)).map((item) => item.id)).toEqual(['outputs/a.mp4']);
  });
});

describe('describeMedia', () => {
  it('reports the size on disk', async () => {
    put('inputs/frame.png', 'abcdef');

    const item = await describeMedia(storage, 'inputs/frame.png');

    expect(item?.bytes).toBe(6);
    expect(item?.kind).toBe('image');
  });

  it('reads the pixel size out of an image header', async () => {
    const header = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IHDR'),
      Buffer.from([0, 0, 4, 176]), // 1200
      Buffer.from([0, 0, 3, 132]), // 900
      Buffer.from([8, 6, 0, 0, 0]),
    ]);
    mkdirSync(path.join(storage, 'inputs'), { recursive: true });
    writeFileSync(path.join(storage, 'inputs', 'shot.png'), header);

    const item = await describeMedia(storage, 'inputs/shot.png');

    expect(item?.width).toBe(1200);
    expect(item?.height).toBe(900);
  });

  it('leaves the size absent rather than guessing at a header it cannot read', async () => {
    put('inputs/broken.png', 'not really a png');
    put('outputs/clip.mp4', 'nor a video header this reads');

    expect((await describeMedia(storage, 'inputs/broken.png'))?.width).toBeUndefined();
    expect((await describeMedia(storage, 'outputs/clip.mp4'))?.width).toBeUndefined();
  });

  it('returns null for an id with no file behind it', async () => {
    expect(await describeMedia(storage, 'inputs/missing.png')).toBeNull();
  });
});

describe('allocateUploadId', () => {
  it('keeps the name when it is free', async () => {
    expect(await allocateUploadId(storage, 'frame.png')).toBe('inputs/frame.png');
  });

  it('never overwrites an image an earlier record already points at', async () => {
    put('inputs/frame.png');
    expect(await allocateUploadId(storage, 'frame.png')).toBe('inputs/frame-2.png');

    put('inputs/frame-2.png');
    expect(await allocateUploadId(storage, 'frame.png')).toBe('inputs/frame-3.png');
  });
});
