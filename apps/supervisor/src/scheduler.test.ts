import { describe, expect, it } from 'vitest';

import { plan, singleExclusiveSlot, type SchedulableArm } from './scheduler.js';

const resident = (id: string): SchedulableArm => ({ id, gpu: 'exclusive', lifecycle: 'resident' });
const oneshot = (id: string): SchedulableArm => ({ id, gpu: 'exclusive', lifecycle: 'oneshot' });
const cpuOnly = (id: string): SchedulableArm => ({ id, gpu: 'none', lifecycle: 'resident' });

describe('singleExclusiveSlot', () => {
  it('evicts nothing when no arm is running', () => {
    expect(plan(resident('a'), [])).toEqual({ start: 'a', evict: [], alreadyRunning: false });
  });

  it('evicts the incumbent exclusive arm', () => {
    expect(plan(resident('b'), [resident('a')])).toEqual({
      start: 'b',
      evict: ['a'],
      alreadyRunning: false,
    });
  });

  it('reports an already running arm without evicting anything', () => {
    expect(plan(resident('a'), [resident('a')])).toEqual({
      start: 'a',
      evict: [],
      alreadyRunning: true,
    });
  });

  it('does not evict for a one-shot arm, which never holds the slot', () => {
    expect(plan(oneshot('img'), [resident('a')])).toEqual({
      start: 'img',
      evict: [],
      alreadyRunning: false,
    });
  });

  it('does not evict for an arm that needs no GPU', () => {
    expect(plan(cpuOnly('b'), [resident('a')])).toEqual({
      start: 'b',
      evict: [],
      alreadyRunning: false,
    });
  });

  it('leaves non-GPU incumbents alone', () => {
    expect(plan(resident('b'), [cpuOnly('a'), resident('c')])).toEqual({
      start: 'b',
      evict: ['c'],
      alreadyRunning: false,
    });
  });

  it('is replaceable without touching callers', () => {
    const evictEverything = (_request: SchedulableArm, running: readonly SchedulableArm[]): string[] =>
      running.map((arm) => arm.id);

    expect(plan(resident('b'), [cpuOnly('a'), oneshot('img')], evictEverything).evict).toEqual([
      'a',
      'img',
    ]);
  });

  it('never asks to evict the arm being started', () => {
    expect(singleExclusiveSlot(resident('a'), [resident('a')])).toEqual([]);
  });
});
