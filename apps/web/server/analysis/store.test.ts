import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnalysisRecord } from '#shared/analysis';

import { listMedia } from '../utils/library';
import { RelayError } from '../utils/supervisor';
import {
  ANALYSES_DIR,
  analysisDir,
  artifactPath,
  isAnalysisId,
  listAnalyses,
  readArtifact,
  readJson,
  readRecord,
  writeArtifact,
  writeJson,
  writeRecord,
} from './store';

let storage: string;

function record(analysisId: string, startedAt: string): AnalysisRecord {
  return {
    analysisId,
    blockName: 'featured-story-card',
    armId: 'text-gemma4-26b-a4b-llamacpp',
    state: 'running',
    startedAt,
  };
}

beforeEach(() => {
  storage = mkdtempSync(path.join(tmpdir(), 'ai-studio-analysis-'));
});

afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe('isAnalysisId', () => {
  it('accepts a plain identifier', () => {
    expect(isAnalysisId('analysis-20260922-a1b2c3')).toBe(true);
  });

  it('refuses anything that is not one', () => {
    for (const bad of ['short', '', '../escape', 'has space', 'has/slash', 'a'.repeat(57), 42, undefined]) {
      expect(isAnalysisId(bad)).toBe(false);
    }
  });

  it('reserves room for the per-pass job suffix', () => {
    // Each pass is a supervisor job named `<analysisId>-p<n>`, and a job id is
    // capped at 64. Discovering that at pass 4 rather than at submit would be
    // a failure three minutes into a run.
    const longest = 'a'.repeat(56);
    expect(isAnalysisId(longest)).toBe(true);
    expect(`${longest}-p4`.length).toBeLessThanOrEqual(64);
    expect(isAnalysisId('a'.repeat(57))).toBe(false);
  });
});

describe('analysisDir', () => {
  it('resolves inside the analyses directory', () => {
    expect(analysisDir(storage, 'analysis-0001')).toBe(
      path.join(storage, ANALYSES_DIR, 'analysis-0001'),
    );
  });

  it('refuses an id that is not one', () => {
    for (const bad of ['../../secret', 'a/b', '..', undefined]) {
      expect(() => analysisDir(storage, bad)).toThrow(RelayError);
    }
  });
});

describe('artifactPath', () => {
  it('allows one directory level, for the passes', () => {
    expect(artifactPath(storage, 'analysis-0001', 'passes/1-inventory.json')).toBe(
      path.join(storage, ANALYSES_DIR, 'analysis-0001', 'passes', '1-inventory.json'),
    );
  });

  it('refuses a name that would escape the analysis directory', () => {
    for (const bad of ['../analysis-0002/analysis.json', 'a/b/c.json', '..', '/etc/passwd']) {
      expect(() => artifactPath(storage, 'analysis-0001', bad)).toThrow(RelayError);
    }
  });
});

describe('artefacts', () => {
  it('round-trips a record', async () => {
    const written = record('analysis-0001', '2026-09-22T10:00:00.000Z');
    await writeRecord(storage, written);
    expect(await readRecord(storage, 'analysis-0001')).toEqual(written);
  });

  it('creates the directory on the first write', async () => {
    await writeArtifact(storage, 'analysis-0001', 'passes/1-inventory.json', '{}');
    expect(await readArtifact(storage, 'analysis-0001', 'passes/1-inventory.json')).toBe('{}');
  });

  it('reports an artefact that was never written as absent', async () => {
    expect(await readArtifact(storage, 'analysis-0001', 'gaps.json')).toBeUndefined();
    expect(await readRecord(storage, 'analysis-0001')).toBeUndefined();
  });

  it('treats a half-written record as absent rather than throwing', async () => {
    // An interrupted run should leave the analysis reported as failed, not
    // crash the route that is trying to report it.
    await writeArtifact(storage, 'analysis-0001', 'analysis.json', '{"analysisId": "ana');
    expect(await readJson(storage, 'analysis-0001', 'analysis.json')).toBeUndefined();
  });

  it('writes JSON a person can read', async () => {
    await writeJson(storage, 'analysis-0001', 'gaps.json', { gaps: [] });
    expect(await readArtifact(storage, 'analysis-0001', 'gaps.json')).toBe('{\n  "gaps": []\n}\n');
  });
});

describe('listAnalyses', () => {
  it('returns nothing when the root does not exist yet', async () => {
    expect(await listAnalyses(storage)).toEqual([]);
  });

  it('lists what is on disk, newest first', async () => {
    await writeRecord(storage, record('analysis-0001', '2026-09-20T10:00:00.000Z'));
    await writeRecord(storage, record('analysis-0002', '2026-09-22T10:00:00.000Z'));

    expect((await listAnalyses(storage)).map((entry) => entry.analysisId)).toEqual([
      'analysis-0002',
      'analysis-0001',
    ]);
  });

  it('skips a directory with no record', async () => {
    mkdirSync(path.join(storage, ANALYSES_DIR, 'analysis-0003'), { recursive: true });
    await writeRecord(storage, record('analysis-0001', '2026-09-20T10:00:00.000Z'));
    expect(await listAnalyses(storage)).toHaveLength(1);
  });
});

describe('the media library', () => {
  it('never sees an analysis', async () => {
    // Not a filter: `listMedia` walks the media roots, and this is not one of
    // them. The test exists so that adding a root later cannot quietly pull a
    // directory of JSON into the library.
    await writeRecord(storage, record('analysis-0001', '2026-09-22T10:00:00.000Z'));
    await writeArtifact(storage, 'analysis-0001', 'design.png', 'not really a png');

    mkdirSync(path.join(storage, 'outputs', '2026-09-22'), { recursive: true });
    writeFileSync(path.join(storage, 'outputs', '2026-09-22', 'clip.mp4'), 'x');

    const media = await listMedia(storage);
    expect(media.map((item) => item.id)).toEqual(['outputs/2026-09-22/clip.mp4']);
  });
});
