import { describe, expect, it } from 'vitest';

import { brokerPlan, sameParams, type RunningArm } from './broker.js';
import type { SchedulableArm } from './scheduler.js';

const video: SchedulableArm = { id: 'video-ltx25', gpu: 'exclusive', lifecycle: 'resident' };
const image: SchedulableArm = { id: 'image-sdcpp', gpu: 'exclusive', lifecycle: 'resident' };

const up = (arm: SchedulableArm, startedWith: Record<string, string> | null = {}): RunningArm => ({
  ...arm,
  startedWith,
});

describe('sameParams', () => {
  it('compares the resolved set, so a default counts as supplied', () => {
    expect(sameParams({ offload: 'group-stream' }, { offload: 'group-stream' })).toBe(true);
    expect(sameParams({ offload: 'group-stream' }, { offload: 'group-disk' })).toBe(false);
  });

  it('treats a missing key as a difference rather than a match', () => {
    expect(sameParams({ offload: 'group' }, {})).toBe(false);
    expect(sameParams({}, { offload: 'group' })).toBe(false);
  });

  it('never matches an arm whose parameters are unknown', () => {
    // An adopted process after a supervisor restart: it is running, but nothing
    // recorded how. Reloading is the only way to be sure what it is.
    expect(sameParams(null, {})).toBe(false);
  });
});

describe('brokerPlan', () => {
  it('reuses an arm already loaded the way the job needs it', () => {
    const plan = brokerPlan(video, { offload: 'group-stream' }, [up(video, { offload: 'group-stream' })]);

    expect(plan.action).toBe('reuse');
    expect(plan.evict).toEqual([]);
  });

  it('starts the arm when nothing holds the card', () => {
    const plan = brokerPlan(video, {}, []);

    expect(plan.action).toBe('start');
    expect(plan.evict).toEqual([]);
    expect(plan.reason).toContain('not loaded yet');
  });

  it('evicts the arm that holds the card, and says which', () => {
    const plan = brokerPlan(video, {}, [up(image)]);

    expect(plan.action).toBe('start');
    expect(plan.evict).toEqual(['image-sdcpp']);
    expect(plan.reason).toContain('image-sdcpp');
  });

  it('reloads the same arm when the job needs a different configuration', () => {
    const plan = brokerPlan(video, { offload: 'group-disk' }, [up(video, { offload: 'group-stream' })]);

    expect(plan.action).toBe('restart');
    // Itself first: the memory has to come back before the replacement loads.
    expect(plan.evict).toEqual(['video-ltx25']);
    expect(plan.reason).toContain('offload');
  });

  it('reloads an adopted arm, because how it was started is unknown', () => {
    const plan = brokerPlan(video, {}, [up(video, null)]);

    expect(plan.action).toBe('restart');
    expect(plan.evict).toEqual(['video-ltx25']);
  });

  it('stops both when the wrong arm holds the card and the right one needs reloading', () => {
    const plan = brokerPlan(video, { offload: 'group-disk' }, [
      up(video, { offload: 'group-stream' }),
      up(image),
    ]);

    expect(plan.action).toBe('restart');
    expect(plan.evict).toEqual(['video-ltx25', 'image-sdcpp']);
  });

  it('leaves a one-shot arm alone: it exits on its own and never holds the slot', () => {
    const oneshot: RunningArm = {
      id: 'image-oneshot',
      gpu: 'exclusive',
      lifecycle: 'oneshot',
      startedWith: {},
    };

    expect(brokerPlan(video, {}, [oneshot]).evict).toEqual([]);
  });
});
