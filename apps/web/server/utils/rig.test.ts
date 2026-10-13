import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RigDraftInfo } from '#shared/generate';

import { checkBoneEdits, DRAFTS_DIR, draftDir, isDraftId, pruneDrafts, readDraftInfo } from './rig';
import { RelayError } from './supervisor';

const info: RigDraftInfo = {
  version: 1,
  vertexCount: 3,
  faceCount: 1,
  influences: 4,
  removeFingers: true,
  bones: [
    { name: 'mixamorig:Hips', parent: -1, head: [0, 0, 0], tail: [0, 0.2, 0] },
    { name: 'mixamorig:Spine', parent: 0, head: [0, 0.2, 0], tail: [0, 0.4, 0] },
  ],
};

describe('draft ids', () => {
  it('accepts plain ids and nothing that could leave the drafts folder', () => {
    expect(isDraftId('0b5e4f1c-2f3a-4c1e-9a77-1d2e3f4a5b6c')).toBe(true);
    for (const bad of ['..', 'short', '../../outputs', 'a/b/cdefghij', '', 42]) expect(isDraftId(bad)).toBe(false);
    expect(() => draftDir('/storage', '../etc/passwd')).toThrow(RelayError);
    expect(draftDir('/storage', 'abcdefgh12')).toBe(path.join('/storage', 'outputs', DRAFTS_DIR, 'abcdefgh12'));
  });
});

describe('checkBoneEdits', () => {
  it('passes known bones with finite points', () => {
    const edits = { 'mixamorig:Spine': { head: [0, 0.21, 0], tail: [0, 0.4, 0.01] } };
    expect(checkBoneEdits(edits, info)).toEqual(edits);
    expect(checkBoneEdits(undefined, info)).toEqual({});
  });

  it.each([
    [{ 'mixamorig:Nope': { head: [0, 0, 0], tail: [0, 1, 0] } }, /not a bone/],
    [{ 'mixamorig:Spine': { head: [0, 0], tail: [0, 1, 0] } }, /three numbers/],
    [{ 'mixamorig:Spine': { head: [0, 0, Number.NaN], tail: [0, 1, 0] } }, /three numbers/],
    [{ 'mixamorig:Spine': { head: [0, 0, 50], tail: [0, 1, 0] } }, /three numbers/],
    [[1, 2], /map bone names/],
  ])('refuses %j', (edits, message) => {
    expect(() => checkBoneEdits(edits, info)).toThrow(message);
  });
});

describe('drafts on disk', () => {
  it('reads rig.json, says when a draft is gone, and clears drafts older than a day', async () => {
    const storage = await mkdtemp(path.join(tmpdir(), 'rig-drafts-'));
    const fresh = draftDir(storage, 'freshdraft01');
    const stale = draftDir(storage, 'staledraft01');
    await mkdir(fresh, { recursive: true });
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(fresh, 'rig.json'), JSON.stringify(info));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    expect((await readDraftInfo(storage, 'freshdraft01')).bones).toHaveLength(2);
    await expect(readDraftInfo(storage, 'nonexistent1')).rejects.toThrow(/detect the rig again/);

    await pruneDrafts(storage);
    expect(await readdir(path.join(storage, 'outputs', DRAFTS_DIR))).toEqual(['freshdraft01']);
  });
});
