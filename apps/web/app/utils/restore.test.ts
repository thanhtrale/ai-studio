import { describe, expect, it } from 'vitest';

import type { MediaMeta } from '#shared/library';

import { restoreKey } from './restore';

const meta = (over: Partial<MediaMeta> = {}): MediaMeta => ({
  source: 'generated',
  createdAt: '2026-09-11T23:54:27.000Z',
  jobId: 'langvi56',
  armId: 'image-qwen-edit-sdcpp',
  prompt: 'một con mèo màu cam',
  ...over,
});

describe('restoreKey', () => {
  it('is the same for two fetches of one record', () => {
    // What the library hands back after a refresh: equal content, new object.
    expect(restoreKey(meta())).toBe(restoreKey(meta()));
    expect(restoreKey(meta())).toBe(restoreKey(meta({ prompt: 'một con mèo màu cam' })));
  });

  it('changes when the record does', () => {
    expect(restoreKey(meta())).not.toBe(restoreKey(meta({ jobId: 'langen57' })));
    expect(restoreKey(meta())).not.toBe(restoreKey(meta({ createdAt: '2026-09-11T23:55:03.000Z' })));
    expect(restoreKey(meta())).not.toBe(restoreKey(meta({ armId: 'video-ltx25-diffusers' })));
  });

  it('still tells two uploads apart, which have no job id at all', () => {
    const first = meta({ source: 'uploaded', jobId: undefined, armId: undefined });
    const second = meta({
      source: 'uploaded',
      jobId: undefined,
      armId: undefined,
      createdAt: '2026-09-11T23:55:03.000Z',
    });

    expect(restoreKey(first)).not.toBe(restoreKey(second));
  });
});
