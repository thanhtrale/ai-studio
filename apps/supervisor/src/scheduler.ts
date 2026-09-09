import type { ArmGpuMode, ArmLifecycle } from '@ai-studio/arm-contract';

export interface SchedulableArm {
  id: string;
  gpu: ArmGpuMode;
  lifecycle: ArmLifecycle;
}

export interface StartPlan {
  start: string;
  evict: string[];
  alreadyRunning: boolean;
}

export type EvictionPolicy = (
  request: SchedulableArm,
  running: readonly SchedulableArm[],
) => string[];

/**
 * Current policy: a single exclusive GPU slot.
 *
 * One-shot arms are transient - they exit on their own and are never resident -
 * so requesting one evicts nothing. Only resident exclusive arms hold the slot.
 *
 * A VRAM-budget policy that lets several small arms coexist is a drop-in
 * replacement for this function; nothing outside it knows the rule.
 */
export const singleExclusiveSlot: EvictionPolicy = (request, running) => {
  if (request.lifecycle !== 'resident' || request.gpu !== 'exclusive') return [];

  return running
    .filter((arm) => arm.lifecycle === 'resident' && arm.gpu === 'exclusive' && arm.id !== request.id)
    .map((arm) => arm.id);
};

export function plan(
  request: SchedulableArm,
  running: readonly SchedulableArm[],
  policy: EvictionPolicy = singleExclusiveSlot,
): StartPlan {
  if (running.some((arm) => arm.id === request.id)) {
    return { start: request.id, evict: [], alreadyRunning: true };
  }

  return { start: request.id, evict: policy(request, running), alreadyRunning: false };
}
