import { afterEach, describe, expect, it } from 'vitest';

import {
  ANALYSIS_STEPS,
  AnalysisRun,
  clearRuns,
  createRun,
  getRun,
  progressFromRecord,
} from './registry';

afterEach(() => clearRuns());

/** A clock a test can advance, so elapsed seconds are asserted rather than raced. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return { now: () => at, advance: (ms) => (at += ms) };
}

describe('AnalysisRun', () => {
  it('declares every step up front so the timeline shows what is coming', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    const progress = run.progress();

    expect(progress.state).toBe('queued');
    expect(progress.steps).toHaveLength(ANALYSIS_STEPS.length);
    expect(progress.steps.every((step) => step.state === 'pending')).toBe(true);
    expect(progress.steps.every((step) => step.seconds === undefined)).toBe(true);
  });

  it('runs a step, then finishes it, and reports each elapsed time', () => {
    const time = clock();
    const run = new AnalysisRun('a-1', 'text-arm', ANALYSIS_STEPS, time.now);

    run.start('design');
    time.advance(2_500);

    const during = run.progress();
    expect(during.state).toBe('running');
    expect(during.steps[0]?.state).toBe('running');
    // A running step reports time so far, which is what makes a long wait legible.
    expect(during.steps[0]?.seconds).toBeCloseTo(2.5);

    run.done('design');
    time.advance(10_000);

    const after = run.progress();
    // A finished step's elapsed stops moving once it is finished.
    expect(after.steps[0]?.state).toBe('done');
    expect(after.steps[0]?.seconds).toBeCloseTo(2.5);
  });

  it('leaves the steps a failure never reached pending, not failed', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    run.start('design');
    run.done('design');
    run.start('ticket');
    run.fail('ticket', 'the export carries no <item>');

    const progress = run.progress();
    expect(progress.state).toBe('failed');
    expect(progress.detail).toBe('the export carries no <item>');
    expect(progress.endedAt).toBeDefined();

    const byKey = new Map(progress.steps.map((step) => [step.key, step.state]));
    expect(byKey.get('design')).toBe('done');
    expect(byKey.get('ticket')).toBe('failed');
    // They did not fail -- they did not happen, and that is how far the run got.
    expect(byKey.get('pass1')).toBe('pending');
    expect(byKey.get('write')).toBe('pending');
  });

  it('keeps a failure once it has happened', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    run.fail('design', 'Figma is not running');
    run.finish();
    expect(run.progress().state).toBe('failed');
  });

  it('nests an arm’s own steps under the pass that made the request', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    run.start('pass3');
    run.graft('pass3', {
      steps: [
        { key: 'load', label: 'Load model', state: 'done', seconds: 12.5 },
        { key: 'prompt', label: 'Prompt processing', state: 'running' },
      ],
      armVram: [],
    });

    const pass = run.progress().steps.find((step) => step.key === 'pass3');
    expect(pass?.children?.map((child) => child.label)).toEqual(['Load model', 'Prompt processing']);
  });

  it('carries the arm’s VRAM series through, without duplicating samples', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    run.start('pass1');
    run.graft('pass1', { steps: [], armVram: [{ at: 10, gib: 9 }, { at: 20, gib: 9.5 }] });
    // A second poll resends what it already sent; only what is new is kept.
    run.graft('pass1', { steps: [], armVram: [{ at: 20, gib: 9.5 }, { at: 30, gib: 9.7 }] });

    expect(run.progress().armVram.map((sample) => sample.at)).toEqual([10, 20, 30]);
  });

  it('carries a detail and a note onto a step', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    run.start('design', '1 frame · 42 nodes');
    run.note('design', 'dropped 118 invisible nodes');

    const step = run.progress().steps[0];
    expect(step?.detail).toBe('1 frame · 42 nodes');
    expect(step?.note).toBe('dropped 118 invisible nodes');
  });

  it('refuses a step key that does not exist', () => {
    const run = new AnalysisRun('a-1', 'text-arm');
    // Otherwise a typo is a silent no-op and the timeline simply never advances.
    expect(() => run.start('pass9')).toThrow(/no analysis step named/);
  });

  it('reports the shape the job timeline already renders', () => {
    const run = new AnalysisRun('a-1', 'text-gemma4-26b-a4b-llamacpp');
    const progress = run.progress();
    expect(progress.jobId).toBe('a-1');
    expect(progress.armId).toBe('text-gemma4-26b-a4b-llamacpp');
    expect(progress.meters).toEqual([]);
    expect(Array.isArray(progress.armVram)).toBe(true);
  });
});

describe('the registry', () => {
  it('finds a run it created, and forgets it when cleared', () => {
    createRun('analysis-1', 'text-arm');
    expect(getRun('analysis-1')).toBeDefined();
    clearRuns();
    expect(getRun('analysis-1')).toBeUndefined();
  });

  it('answers for a run that was registered but has not started', () => {
    // The submit and the console's first poll race by a few milliseconds, so
    // progress has to be readable the instant a run exists.
    const run = createRun('analysis-2', 'text-arm');
    expect(run.progress().state).toBe('queued');
    expect(getRun('analysis-2')?.progress().steps[0]?.state).toBe('pending');
  });
});

describe('progressFromRecord', () => {
  const base = {
    analysisId: 'analysis-0001',
    blockName: 'featured-story-card',
    armId: 'text-arm',
    startedAt: '2026-09-22T10:00:00.000Z',
  } as const;

  it('reports a record still saying running as failed when nothing is running it', () => {
    // The registry is module state and a Nuxt reload empties it. A record with
    // no run behind it is a run that died, and reporting it as running would
    // be a spinner that never stops.
    const progress = progressFromRecord({ ...base, state: 'running' });
    expect(progress.state).toBe('failed');
    expect(progress.detail).toMatch(/restarted/);
    expect(progress.steps.every((step) => step.state === 'pending')).toBe(true);
  });

  it('keeps a recorded failure and its reason', () => {
    const progress = progressFromRecord({
      ...base,
      state: 'failed',
      detail: 'Figma is not running',
      endedAt: '2026-09-22T10:04:00.000Z',
    });
    expect(progress.state).toBe('failed');
    expect(progress.detail).toBe('Figma is not running');
    expect(progress.endedAt).toBe(Date.parse('2026-09-22T10:04:00.000Z'));
  });

  it('marks every step done for a completed analysis', () => {
    const progress = progressFromRecord({ ...base, state: 'done' });
    expect(progress.state).toBe('done');
    expect(progress.steps.every((step) => step.state === 'done')).toBe(true);
    // Per-step timings were never written down; inventing them would be worse
    // than their absence.
    expect(progress.steps.every((step) => step.seconds === undefined)).toBe(true);
  });
});
