import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverArms } from './discovery.js';
import {
  EMPTY_PARAMS_SCHEMA,
  makeTempRoot,
  residentManifest,
  writeArms,
  type ArmFixture,
} from './test-utils.js';

async function discoverFixtures(fixtures: readonly ArmFixture[]) {
  const root = await makeTempRoot();
  const armsDir = path.join(root, 'arms');
  await writeArms(armsDir, fixtures);
  return discoverArms(armsDir);
}

describe('discoverArms', () => {
  it('registers a directory holding a valid manifest', async () => {
    const result = await discoverFixtures([
      { dirName: 'text-fake', manifest: residentManifest('text-fake'), paramsSchema: EMPTY_PARAMS_SCHEMA },
    ]);

    expect(result.invalid).toEqual([]);
    expect(result.arms).toHaveLength(1);
    expect(result.arms[0]?.id).toBe('text-fake');
    expect(result.arms[0]?.manifest.modality).toBe('text');
  });

  it('skips a directory with no manifest', async () => {
    const result = await discoverFixtures([
      { dirName: 'not-an-arm' },
      { dirName: 'text-fake', manifest: residentManifest('text-fake'), paramsSchema: EMPTY_PARAMS_SCHEMA },
    ]);

    expect(result.arms.map((arm) => arm.id)).toEqual(['text-fake']);
    expect(result.invalid).toEqual([]);
  });

  it('retains an invalid manifest with its error without dropping valid arms', async () => {
    const result = await discoverFixtures([
      { dirName: 'broken', manifest: 'id: broken\nmodality: text\n', paramsSchema: EMPTY_PARAMS_SCHEMA },
      { dirName: 'text-fake', manifest: residentManifest('text-fake'), paramsSchema: EMPTY_PARAMS_SCHEMA },
    ]);

    expect(result.arms.map((arm) => arm.id)).toEqual(['text-fake']);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.id).toBe('broken');
    expect(result.invalid[0]?.error).toMatch(/protocol|lifecycle|launch|params/);
  });

  it('names the offending field when a required key is missing', async () => {
    const result = await discoverFixtures([
      {
        dirName: 'no-protocol',
        manifest: residentManifest('no-protocol').replace('protocol: openai\n', ''),
        paramsSchema: EMPTY_PARAMS_SCHEMA,
      },
    ]);

    expect(result.arms).toEqual([]);
    expect(result.invalid[0]?.error).toContain('protocol');
  });

  it('rejects an unknown protocol value', async () => {
    const result = await discoverFixtures([
      {
        dirName: 'weird',
        manifest: residentManifest('weird').replace('protocol: openai', 'protocol: telepathy'),
        paramsSchema: EMPTY_PARAMS_SCHEMA,
      },
    ]);

    expect(result.arms).toEqual([]);
    expect(result.invalid[0]?.error).toContain('protocol');
  });

  it('reports a conflict and registers neither arm when ids collide', async () => {
    const result = await discoverFixtures([
      { dirName: 'copy-a', manifest: residentManifest('twin'), paramsSchema: EMPTY_PARAMS_SCHEMA },
      { dirName: 'copy-b', manifest: residentManifest('twin'), paramsSchema: EMPTY_PARAMS_SCHEMA },
    ]);

    expect(result.arms).toEqual([]);
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid[0]?.error).toContain('copy-a, copy-b');
  });

  it('marks an arm invalid when its parameter schema is missing', async () => {
    const result = await discoverFixtures([
      { dirName: 'no-schema', manifest: residentManifest('no-schema') },
    ]);

    expect(result.arms).toEqual([]);
    expect(result.invalid[0]?.error).toContain('params');
  });
});
