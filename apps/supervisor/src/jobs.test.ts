import { describe, expect, it } from 'vitest';

import { JobStore } from './jobs.js';

function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

describe('JobStore', () => {
  it('reports a job as queued until the arm says anything', () => {
    const store = new JobStore();
    store.open('job-1', 'video-ltx25');

    const snapshot = store.snapshot('job-1');
    expect(snapshot?.state).toBe('queued');
    expect(snapshot?.steps.map((step) => step.label)).toEqual(['Queued for the card']);
  });

  it('ticks the broker step while it is still running', () => {
    const time = clock();
    const store = new JobStore({ now: time.now });
    store.open('job-1', 'video-ltx25');

    time.advance(2500);
    expect(store.snapshot('job-1')?.steps[0]?.seconds).toBe(2.5);
    expect(store.snapshot('job-1')?.steps[0]?.state).toBe('running');
  });

  it('freezes the broker step once the card is ready', () => {
    const time = clock();
    const store = new JobStore({ now: time.now });
    store.open('job-1', 'video-ltx25');
    store.plan('job-1', 'image-sdcpp holds the card');
    store.did('job-1', 'stop', 'Stopped image-sdcpp', 1.2);

    time.advance(3000);
    store.acquired('job-1');
    time.advance(60_000);

    const step = store.snapshot('job-1')?.steps[0];
    expect(step?.state).toBe('done');
    expect(step?.seconds).toBe(3);
    expect(step?.detail).toBe('image-sdcpp holds the card');
    expect(step?.children?.map((child) => child.label)).toEqual(['Stopped image-sdcpp']);
  });

  it("appends the arm's own steps after its own, without touching them", () => {
    const store = new JobStore();
    store.open('job-1', 'video-ltx25');
    store.acquired('job-1');
    store.arm('job-1', {
      steps: [
        { key: 'load', label: 'Load model', state: 'done', seconds: 24.9 },
        { key: 'denoise', label: 'Denoise', state: 'running' },
      ],
      meters: [{ key: 'denoise', label: 'Denoise', done: 3, total: 8 }],
      vram: [{ at: 5, gib: 5.17 }],
    });

    const snapshot = store.snapshot('job-1');
    expect(snapshot?.state).toBe('running');
    expect(snapshot?.steps.map((step) => step.label)).toEqual([
      'Queued for the card',
      'Load model',
      'Denoise',
    ]);
    expect(snapshot?.meters[0]?.done).toBe(3);
    expect(snapshot?.armVram).toEqual([{ at: 5, gib: 5.17 }]);
  });

  it('keeps the reason a job failed, and marks an unfinished broker step failed too', () => {
    const store = new JobStore();
    store.open('job-1', 'video-ltx25');
    store.fail('job-1', 'arm did not become healthy within 120000ms');

    const snapshot = store.snapshot('job-1');
    expect(snapshot?.state).toBe('failed');
    expect(snapshot?.detail).toContain('healthy');
    expect(snapshot?.steps[0]?.state).toBe('failed');
  });

  it('leaves a finished broker step alone when the arm fails later', () => {
    const store = new JobStore();
    store.open('job-1', 'video-ltx25');
    store.acquired('job-1');
    store.fail('job-1', 'CUDA out of memory');

    expect(store.snapshot('job-1')?.steps[0]?.state).toBe('done');
  });

  it('knows whether anything is still in flight', () => {
    const store = new JobStore();
    expect(store.live).toBe(false);

    store.open('job-1', 'video-ltx25');
    expect(store.live).toBe(true);

    store.done('job-1');
    expect(store.live).toBe(false);
  });

  it('drops the oldest history rather than growing without bound', () => {
    const store = new JobStore();
    for (let index = 0; index < 40; index += 1) store.open(`job-${index}`, 'video-ltx25');

    expect(store.has('job-0')).toBe(false);
    expect(store.has('job-39')).toBe(true);
  });

  it('says nothing about a job it has never seen', () => {
    expect(new JobStore().snapshot('nope')).toBeUndefined();
  });
});
