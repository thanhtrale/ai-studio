import type { ArmSummary, InventoryResponse } from '@ai-studio/arm-contract';

import type { ConnectionState } from '../types';

const POLL_INTERVAL_MS = 1500;

/**
 * Arm state, fetched on the server for the first paint and polled after it.
 *
 * One `useAsyncData` key, so the layout and whichever page is mounted read the
 * same request rather than two. Polling belongs to the layout alone -- it is the
 * component that outlives navigation.
 */
export function useArms() {
  const { data, error, refresh, status } = useAsyncData<InventoryResponse>('arms', () => $fetch('/api/arms'), {
    default: () => ({ arms: [], ready: false }),
  });

  const arms = computed<ArmSummary[]>(() => data.value?.arms ?? []);

  const connection = computed<ConnectionState>(() => {
    if (error.value) return 'unreachable';
    if (status.value === 'pending' && arms.value.length === 0) return 'loading';
    return 'connected';
  });

  /** The arm holding the exclusive GPU slot, if any. At most one ever is. */
  const incumbent = computed(
    () =>
      arms.value.find(
        (arm) => arm.state === 'running' && arm.gpu === 'exclusive' && arm.lifecycle === 'resident',
      ) ?? null,
  );

  return { arms, connection, incumbent, refresh, error };
}

/** Keeps the inventory current for as long as the caller is mounted. */
export function useArmPolling(refresh: () => Promise<void>): void {
  if (!import.meta.client) return;

  const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  onBeforeUnmount(() => clearInterval(timer));
}

/** Start or stop one arm, reporting what went wrong in the caller's own words. */
export function useArmControl(refresh: () => Promise<void>) {
  const busy = ref<Record<string, 'starting' | 'stopping'>>({});
  const failure = ref<string | null>(null);

  async function operate(armId: string, operation: 'starting' | 'stopping'): Promise<void> {
    busy.value = { ...busy.value, [armId]: operation };
    failure.value = null;

    try {
      await $fetch(`/api/arms/${encodeURIComponent(armId)}/${operation === 'starting' ? 'start' : 'stop'}`, {
        method: 'POST',
        body: operation === 'starting' ? { params: {} } : undefined,
      });
    } catch (error) {
      failure.value = describeFetchError(error);
    } finally {
      const next = { ...busy.value };
      delete next[armId];
      busy.value = next;
      await refresh();
    }
  }

  return { busy, failure, operate };
}

/** Our routes carry the reason in `data.message`; anything else is a real exception. */
export function describeFetchError(error: unknown): string {
  const data = (error as { data?: { data?: { message?: string } } }).data?.data;
  return data?.message ?? (error as Error).message;
}
