import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { armImagePath, mediaIdFromPath } from './jobs';
import { RelayError } from './supervisor';

const STORAGE = path.resolve('C:/studio/storage');

describe('mediaIdFromPath', () => {
  it('translates a path the arm reports into a library id', () => {
    const reported = path.join(STORAGE, 'outputs', '2026-09-11', '143022-abcd1234.mp4');
    expect(mediaIdFromPath(STORAGE, reported)).toBe('outputs/2026-09-11/143022-abcd1234.mp4');
  });

  it('returns null for a file written outside the scanned roots', () => {
    expect(mediaIdFromPath(STORAGE, path.join(STORAGE, 'cache', 'scratch.mp4'))).toBeNull();
    expect(mediaIdFromPath(STORAGE, path.resolve('C:/elsewhere/a.mp4'))).toBeNull();
  });
});

describe('armImagePath', () => {
  it('names the file relative to the arm input directory', () => {
    expect(armImagePath('inputs/frame.png')).toBe('frame.png');
    expect(armImagePath('inputs/batch/frame.png')).toBe('batch/frame.png');
  });

  it('refuses a reference the arm is not allowed to read', () => {
    // Generated media lives under outputs/, which no arm may read a job input
    // from -- so this is refused here rather than handed over to be rejected.
    expect(() => armImagePath('outputs/2026-09-11/a.png')).toThrow(/must live under inputs/);
  });

  it('refuses a video as a conditioning frame', () => {
    expect(() => armImagePath('inputs/clip.mp4')).toThrow(/must be an image/);
  });

  it('refuses anything that is not a media id at all', () => {
    for (const bad of ['../../.env', '/etc/passwd.png', 'inputs/../models/x.png', undefined, 7]) {
      expect(() => armImagePath(bad)).toThrow(RelayError);
    }
  });
});
