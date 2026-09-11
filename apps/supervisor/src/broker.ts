import type { LaunchValue } from '@ai-studio/arm-contract';

import { singleExclusiveSlot, type EvictionPolicy, type SchedulableArm } from './scheduler.js';

/**
 * Deciding what has to happen to the GPU before a job can run.
 *
 * Separate from `plan()` because it answers a different question. `plan()` is
 * asked "start this arm"; this is asked "run this job", which can be satisfied
 * by an arm that is already up -- but only if it is up in the configuration the
 * job needs. Start parameters decide how 36 GiB of weights are placed and cannot
 * change without reloading them, so an arm running with different ones is the
 * wrong arm, not the right arm with a setting to adjust.
 */

export type BrokerAction = 'reuse' | 'start' | 'restart';

export interface RunningArm extends SchedulableArm {
  /** The resolved values it was started with, or null if that is unknown. */
  startedWith: Readonly<Record<string, LaunchValue>> | null;
}

export interface BrokerPlan {
  action: BrokerAction;
  /** Arms to stop first, in order. Includes the requested arm on a restart. */
  evict: string[];
  /** Said to the user, so it has to be true and worth reading. */
  reason: string;
}

/** Same keys, same values. The resolved set, so defaults count as supplied. */
export function sameParams(
  a: Readonly<Record<string, LaunchValue>> | null,
  b: Readonly<Record<string, LaunchValue>>,
): boolean {
  if (a === null) return false;

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function differing(
  a: Readonly<Record<string, LaunchValue>> | null,
  b: Readonly<Record<string, LaunchValue>>,
): string[] {
  if (a === null) return ['configuration'];

  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((key) => a[key] !== b[key]);
}

export function brokerPlan(
  request: SchedulableArm,
  params: Readonly<Record<string, LaunchValue>>,
  running: readonly RunningArm[],
  policy: EvictionPolicy = singleExclusiveSlot,
): BrokerPlan {
  const current = running.find((arm) => arm.id === request.id) ?? null;

  if (current && sameParams(current.startedWith, params)) {
    return { action: 'reuse', evict: [], reason: `${request.id} is already loaded` };
  }

  const others = policy(
    request,
    running.filter((arm) => arm.id !== request.id),
  );

  if (current) {
    const changed = differing(current.startedWith, params);
    return {
      action: 'restart',
      // Itself first: it holds the card, and the replacement cannot load until
      // that memory is actually back.
      evict: [request.id, ...others],
      reason: `${request.id} is loaded with a different ${changed.join(', ')} and has to be reloaded`,
    };
  }

  return {
    action: 'start',
    evict: others,
    reason:
      others.length > 0
        ? `${others.join(', ')} holds the card and has to stop before ${request.id} can load`
        : `${request.id} is not loaded yet`,
  };
}
