import { describe, expect, it } from 'vitest';

import {
  contentType,
  facetsOf,
  featureOf,
  filterMedia,
  formatBytes,
  formatCount,
  formatSeconds,
  generatedMediaId,
  groupLabel,
  groupMedia,
  groupOf,
  isMediaId,
  mediaKind,
  mediaSeconds,
  mediaTags,
  recordId,
  sanitiseCollection,
  sanitiseUploadName,
  shortDescription,
  sourceLabel,
  sourceOf,
  stackMedia,
  type ImageJobSettings,
  type MediaItem,
} from './library';

/** A generated image, recorded the way the image route records one. */
const batchImage = (id: string, jobId: string, index: number, batch: number, at: string): MediaItem => ({
  id,
  name: id.slice(id.lastIndexOf('/') + 1),
  kind: 'image',
  group: groupOf(id),
  bytes: 1024,
  modifiedAt: at,
  meta: {
    source: 'generated',
    createdAt: at,
    jobId,
    armId: 'image-qwen-edit-sdcpp',
    settings: {
      kind: 'image',
      width: 768,
      height: 768,
      seed: 100 + index,
      steps: 4,
      cfgScale: 1,
      sampler: 'euler_a',
      scheduler: 'beta',
      flowShift: 3,
      batch,
      batchIndex: index,
    } satisfies ImageJobSettings,
  },
});

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

  it('files into a named collection instead of the date when given one', () => {
    const at = new Date(2026, 8, 11, 14, 30, 22);
    expect(generatedMediaId('refall-0001', at, '.png', 'ref-crawl')).toBe(
      'outputs/ref-crawl/143022-refall-0.png',
    );
  });
});

describe('sanitiseCollection', () => {
  it('folds a name down to one safe segment', () => {
    expect(sanitiseCollection('Ref Crawl 2026')).toBe('ref-crawl-2026');
    expect(sanitiseCollection('  spaced  ')).toBe('spaced');
  });

  it('refuses to let a collection become a path or a device', () => {
    expect(sanitiseCollection('../../etc')).toBe('etc');
    expect(sanitiseCollection('a/b')).toBe('a-b');
    expect(sanitiseCollection('..')).toBeNull();
    expect(sanitiseCollection('nul')).toBeNull();
    expect(sanitiseCollection('   ')).toBeNull();
    expect(sanitiseCollection(42)).toBeNull();
  });

  it('yields ids the library will accept', () => {
    const name = sanitiseCollection('Ref Crawl / 30 Sep');
    expect(isMediaId(generatedMediaId('refall-0001', new Date(), '.png', name ?? undefined))).toBe(
      true,
    );
  });
});

describe('mediaTags', () => {
  const generated = (armId: string, over: Record<string, unknown> = {}) =>
    item('outputs/a/x.png', {
      meta: {
        source: 'generated',
        createdAt: '2026-09-30T10:00:00.000Z',
        armId,
        settings: { kind: 'image', width: 1024, height: 1024, seed: 1, steps: 6, batch: 1, batchIndex: 0 } as ImageJobSettings,
        ...over,
      },
    });

  it('names the backend and the model apart, so two runs compare', () => {
    expect(mediaTags(generated('image-qwen21-turbo-comfy'))).toEqual([
      'comfy',
      'qwen2.1',
      'turbo',
      't2i',
    ]);
    expect(mediaTags(generated('image-qwen-edit-comfy'))).toEqual(['comfy', 'qwen2511', 't2i']);
  });

  it('says whether the run was conditioned on an image', () => {
    expect(mediaTags(generated('image-qwen-edit-comfy', { referenceId: 'inputs/a.png' }))).toContain(
      'i2i',
    );
    expect(
      mediaTags(generated('image-qwen-edit-comfy', { referenceIds: ['inputs/a.png'] })),
    ).toContain('i2i');
  });

  it('reads video the same way', () => {
    const clip = item('outputs/a/x.mp4', {
      meta: {
        source: 'generated',
        createdAt: '2026-09-30T10:00:00.000Z',
        armId: 'video-ltx25-diffusers',
        referenceId: 'inputs/a.png',
      },
    });
    expect(mediaTags(clip)).toEqual(['diffusers', 'ltx2.5', 'i2v']);
  });

  it('falls back to the arm id for an arm it has no words for', () => {
    expect(mediaTags(generated('image-something-new'))).toEqual(['something-new', 't2i']);
  });

  it('has nothing to say about a file no arm made', () => {
    expect(mediaTags(item('inputs/photo.png'))).toEqual([]);
    expect(
      mediaTags(
        item('inputs/photo.png', {
          meta: { source: 'uploaded', createdAt: '2026-09-30T10:00:00.000Z' },
        }),
      ),
    ).toEqual([]);
  });
});

describe('mediaSeconds', () => {
  const timed = (secondsTotal: number, count: number) =>
    item('outputs/a/x.png', {
      meta: {
        source: 'generated',
        createdAt: '2026-09-30T10:00:00.000Z',
        armId: 'image-qwen21-turbo-comfy',
        output: { width: 1024, height: 1024, count },
        report: { secondsTotal, steps: 6, peakVramGib: 14.5, stages: [] },
      },
    });

  it('divides a job-wide total by the files it produced', () => {
    expect(mediaSeconds(timed(11.9, 1))).toBeCloseTo(11.9);
    expect(mediaSeconds(timed(735.4, 100))).toBeCloseTo(7.354);
  });

  it('is null where nothing timed the file', () => {
    expect(mediaSeconds(item('inputs/photo.png'))).toBeNull();
    expect(mediaSeconds(timed(0, 1))).toBeNull();
  });
});

describe('formatSeconds', () => {
  it('stays short enough for a chip', () => {
    expect(formatSeconds(11.94)).toBe('11.9s');
    expect(formatSeconds(59.9)).toBe('59.9s');
    expect(formatSeconds(735.4)).toBe('12m 15s');
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

  it('drops the arm where something else already names it', () => {
    const described = shortDescription(
      item('outputs/a/x.png', {
        bytes: 1_048_576,
        meta: {
          source: 'generated',
          createdAt: '2026-09-30T10:00:00.000Z',
          armId: 'image-qwen21-turbo-comfy',
          output: { width: 1024, height: 1024, count: 1 },
        },
      }),
      { arm: false },
    );

    expect(described).toBe('1024×1024 · 1.0 MB');
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

describe('featureOf', () => {
  it('reads the feature off the settings rather than off the file type', () => {
    expect(featureOf(batchImage('outputs/a/1.png', 'job', 0, 4, '2026-09-11T10:00:00.000Z'))).toBe(
      'image.generate',
    );
  });

  it('leaves an upload with no feature, because no arm made it', () => {
    const uploaded = item('inputs/frame.png', {
      meta: { source: 'uploaded', createdAt: '2026-09-11T10:00:00.000Z' },
    });

    expect(featureOf(uploaded)).toBeNull();
    expect(sourceOf(uploaded)).toBe('uploaded');
  });

  it('falls back to the file for a generation recorded before settings were kept', () => {
    const old = item('outputs/a/clip.mp4', {
      meta: { source: 'generated', createdAt: '2026-09-01T10:00:00.000Z' },
    });

    expect(featureOf(old)).toBe('video.generate');
  });

  it('calls a file with no record untracked', () => {
    expect(sourceOf(item('outputs/bench/x.mp4'))).toBe('untracked');
    expect(sourceLabel('untracked')).toBe('Untracked');
    expect(sourceLabel('image-qwen-edit-sdcpp')).toBe('image-qwen-edit-sdcpp');
  });
});

describe('filterMedia', () => {
  const images = [
    batchImage('outputs/a/1.png', 'job', 0, 2, '2026-09-11T10:00:00.000Z'),
    batchImage('outputs/a/2.png', 'job', 1, 2, '2026-09-11T10:00:00.000Z'),
  ];
  const clip = item('outputs/a/clip.mp4', {
    meta: { source: 'generated', createdAt: '2026-09-11T09:00:00.000Z', armId: 'video-ltx25-diffusers' },
  });
  const upload = item('inputs/frame.png', {
    meta: { source: 'uploaded', createdAt: '2026-09-11T08:00:00.000Z' },
  });
  const all = [...images, clip, upload];

  it('keeps only what a feature produced', () => {
    expect(filterMedia(all, { feature: 'image.generate' }).map((entry) => entry.id)).toEqual([
      'outputs/a/1.png',
      'outputs/a/2.png',
    ]);
    expect(filterMedia(all, { feature: 'video.generate' }).map((entry) => entry.id)).toEqual([
      'outputs/a/clip.mp4',
    ]);
  });

  it('keeps everything when neither filter names something it understands', () => {
    expect(filterMedia(all, { feature: 'all', source: 'all' })).toHaveLength(4);
    expect(filterMedia(all, {})).toHaveLength(4);
  });

  it('filters by arm, and by the two states that are not arms', () => {
    expect(filterMedia(all, { source: 'video-ltx25-diffusers' }).map((entry) => entry.id)).toEqual([
      'outputs/a/clip.mp4',
    ]);
    expect(filterMedia(all, { source: 'uploaded' }).map((entry) => entry.id)).toEqual(['inputs/frame.png']);
  });

  it('combines the two, because they answer different questions', () => {
    expect(filterMedia(all, { feature: 'image.generate', source: 'video-ltx25-diffusers' })).toEqual([]);
  });

  it('offers only the values actually present, commonest first', () => {
    expect(facetsOf(all, sourceOf, sourceLabel)).toEqual([
      { value: 'image-qwen-edit-sdcpp', label: 'image-qwen-edit-sdcpp', count: 2 },
      { value: 'uploaded', label: 'Uploaded', count: 1 },
      { value: 'video-ltx25-diffusers', label: 'video-ltx25-diffusers', count: 1 },
    ]);
  });
});

describe('stackMedia', () => {
  it('collapses a batch into one card, in the order the job wrote it', () => {
    const entries = stackMedia([
      batchImage('outputs/a/3.png', 'job-a', 2, 3, '2026-09-11T10:00:00.000Z'),
      batchImage('outputs/a/1.png', 'job-a', 0, 3, '2026-09-11T10:00:00.000Z'),
      batchImage('outputs/a/2.png', 'job-a', 1, 3, '2026-09-11T10:00:00.000Z'),
    ]);

    expect(entries).toHaveLength(1);
    const [stack] = entries;
    expect(stack?.kind).toBe('stack');
    if (stack?.kind !== 'stack') return;
    expect(stack.items.map((entry) => entry.name)).toEqual(['1.png', '2.png', '3.png']);
    expect(stack.cover.name).toBe('1.png');
  });

  it('holds the batch where its first member was, rather than floating to the top', () => {
    const entries = stackMedia([
      item('outputs/a/newer.mp4', { modifiedAt: '2026-09-11T12:00:00.000Z' }),
      batchImage('outputs/a/1.png', 'job-a', 0, 2, '2026-09-11T10:00:00.000Z'),
      batchImage('outputs/a/2.png', 'job-a', 1, 2, '2026-09-11T10:00:00.000Z'),
      item('outputs/a/older.mp4', { modifiedAt: '2026-09-11T08:00:00.000Z' }),
    ]);

    expect(entries.map((entry) => entry.key)).toEqual([
      'outputs/a/newer.mp4',
      'outputs/a/job-a',
      'outputs/a/older.mp4',
    ]);
  });

  it('keeps two jobs apart even when they landed in the same folder', () => {
    const entries = stackMedia([
      batchImage('outputs/a/1.png', 'job-a', 0, 2, '2026-09-11T10:00:00.000Z'),
      batchImage('outputs/a/2.png', 'job-a', 1, 2, '2026-09-11T10:00:00.000Z'),
      batchImage('outputs/a/3.png', 'job-b', 0, 2, '2026-09-11T11:00:00.000Z'),
      batchImage('outputs/a/4.png', 'job-b', 1, 2, '2026-09-11T11:00:00.000Z'),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.key)).toEqual(['outputs/a/job-a', 'outputs/a/job-b']);
  });

  it('shows a lone survivor of a batch as itself', () => {
    // The other three were deleted: there is no folder left to open.
    const entries = stackMedia([batchImage('outputs/a/1.png', 'job-a', 0, 4, '2026-09-11T10:00:00.000Z')]);

    expect(entries).toEqual([
      { kind: 'item', key: 'outputs/a/1.png', item: expect.objectContaining({ id: 'outputs/a/1.png' }) },
    ]);
  });

  it('never stacks jobs that asked for one image each', () => {
    const entries = stackMedia([
      batchImage('outputs/a/1.png', 'job-a', 0, 1, '2026-09-11T10:00:00.000Z'),
      batchImage('outputs/a/2.png', 'job-b', 0, 1, '2026-09-11T10:00:00.000Z'),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['item', 'item']);
  });
});

describe('3D models', () => {
  const mesh: MediaItem = {
    id: 'outputs/2026-10-06/120000-abcdef12.glb',
    name: '120000-abcdef12.glb',
    kind: 'model',
    group: 'outputs/2026-10-06',
    bytes: 2_400_000,
    modifiedAt: '2026-10-06T12:00:00.000Z',
    meta: {
      source: 'generated',
      createdAt: '2026-10-06T12:00:00.000Z',
      jobId: 'abcdef12-0000',
      armId: 'mesh-hunyuan3d-comfy',
      referenceId: 'inputs/chair.png',
      settings: {
        kind: 'model',
        steps: 30,
        cfgScale: 5,
        sampler: 'euler',
        scheduler: 'normal',
        octreeResolution: 256,
        latentTokens: 4096,
        targetFaces: 50_000,
        removeBackground: true,
        seed: 1,
        batch: 1,
        batchIndex: 0,
      },
      output: { count: 1, faces: 49_998, vertices: 25_001 },
    },
  };

  it('treats a GLB as a model, and only a binary one', () => {
    expect(mediaKind('a.glb')).toBe('model');
    expect(mediaKind('a.gltf')).toBeNull();
    expect(isMediaId('outputs/2026-10-06/a.glb')).toBe(true);
    expect(contentType('a.glb')).toBe('model/gltf-binary');
  });

  it('files a mesh under its own feature, even without settings', () => {
    expect(featureOf(mesh)).toBe('mesh.generate');
    const bare: MediaItem = { ...mesh, meta: { source: 'generated', createdAt: mesh.modifiedAt } };
    expect(featureOf(bare)).toBe('mesh.generate');
    expect(filterMedia([mesh], { feature: 'mesh.generate' })).toHaveLength(1);
    expect(filterMedia([mesh], { feature: 'image.generate' })).toHaveLength(0);
  });

  it('describes a mesh by its faces, not a frame', () => {
    expect(shortDescription(mesh)).toBe('50K faces · 2.3 MB · hunyuan3d-comfy');
    expect(mediaTags(mesh)).toEqual(['comfy', 'hunyuan3d2.1', 'i23d']);
  });

  it('formats counts for a chip', () => {
    expect(formatCount(950)).toBe('950');
    expect(formatCount(49_998)).toBe('50K');
    expect(formatCount(1_250_000)).toBe('1.3M');
  });
});
