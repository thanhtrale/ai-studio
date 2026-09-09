<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { ConnectionState, PendingOperation } from '../types';

const props = defineProps<{
  arms: ArmSummary[];
  connection: ConnectionState;
  /** Arms with an operation in flight, keyed by arm id. */
  busy?: Record<string, PendingOperation>;
}>();

const emit = defineEmits<{ start: [string]; stop: [string] }>();

const pendingEviction = ref<{ requested: ArmSummary; incumbent: ArmSummary } | null>(null);

const busyFor = (arm: ArmSummary): PendingOperation | undefined => props.busy?.[arm.id];

/** The arm currently holding the exclusive GPU slot, if any. */
const incumbent = computed(
  () =>
    props.arms.find(
      (arm) => arm.state === 'running' && arm.gpu === 'exclusive' && arm.lifecycle === 'resident',
    ) ?? null,
);

const stateLabel = (arm: ArmSummary): string => {
  const pending = busyFor(arm);
  if (pending === 'starting') return 'starting';
  if (pending === 'stopping') return 'stopping';
  return arm.state;
};

const canStart = (arm: ArmSummary): boolean =>
  arm.state !== 'invalid' && arm.state !== 'running' && arm.lifecycle === 'resident' && !busyFor(arm);

const canStop = (arm: ArmSummary): boolean => arm.state === 'running' && !busyFor(arm);

function requestStart(arm: ArmSummary): void {
  const holder = incumbent.value;
  if (holder && holder.id !== arm.id && arm.gpu === 'exclusive' && arm.lifecycle === 'resident') {
    pendingEviction.value = { requested: arm, incumbent: holder };
    return;
  }
  emit('start', arm.id);
}

function confirmEviction(): void {
  const pending = pendingEviction.value;
  if (!pending) return;
  pendingEviction.value = null;
  emit('start', pending.requested.id);
}

const badgeClass = (arm: ArmSummary): string => {
  switch (stateLabel(arm)) {
    case 'running':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'failed':
    case 'invalid':
      return 'bg-rose-500/15 text-rose-300';
    case 'starting':
    case 'stopping':
      return 'bg-amber-500/15 text-amber-300';
    default:
      return 'bg-slate-500/15 text-slate-300';
  }
};
</script>

<template>
  <section class="space-y-4">
    <p v-if="connection === 'loading'" data-testid="connection-loading" class="text-sm text-slate-400">
      Contacting the supervisor…
    </p>

    <div
      v-else-if="connection === 'unreachable'"
      data-testid="supervisor-unavailable"
      class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <h2 class="font-medium text-amber-200">Supervisor unavailable</h2>
      <p class="mt-1 text-sm text-amber-100/80">
        Arm state is unknown while the supervisor is down. Start it with
        <code class="rounded bg-black/30 px-1">pnpm dev</code>; this view recovers on its own.
      </p>
    </div>

    <template v-else>
      <div
        v-if="pendingEviction"
        data-testid="eviction-confirm"
        class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
      >
        <p class="text-sm text-amber-100">
          Starting <strong>{{ pendingEviction.requested.id }}</strong> will stop
          <strong>{{ pendingEviction.incumbent.id }}</strong> to free the GPU.
        </p>
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            data-testid="eviction-confirm-button"
            class="rounded bg-amber-400 px-3 py-1 text-sm font-medium text-slate-900"
            @click="confirmEviction"
          >
            Stop it and continue
          </button>
          <button
            type="button"
            data-testid="eviction-cancel-button"
            class="rounded border border-slate-600 px-3 py-1 text-sm"
            @click="pendingEviction = null"
          >
            Cancel
          </button>
        </div>
      </div>

      <p v-if="arms.length === 0" data-testid="empty" class="text-sm text-slate-400">
        No arms discovered under <code>arms/</code>.
      </p>

      <ul class="grid gap-3">
        <li
          v-for="arm in arms"
          :key="arm.id"
          :data-testid="`arm-${arm.id}`"
          class="rounded-lg border border-slate-700 bg-surface-raised p-4"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="font-medium text-slate-100">{{ arm.id }}</h3>
              <p class="text-sm text-slate-400">
                {{ arm.modality ?? 'unknown modality' }}
                <span v-if="arm.lifecycle"> · {{ arm.lifecycle }}</span>
              </p>
            </div>
            <span :data-testid="`state-${arm.id}`" class="rounded px-2 py-1 text-xs" :class="badgeClass(arm)">
              {{ stateLabel(arm) }}
            </span>
          </div>

          <p v-if="arm.detail" :data-testid="`detail-${arm.id}`" class="mt-2 text-sm text-rose-300">
            {{ arm.detail }}
          </p>

          <div class="mt-3 flex gap-2">
            <button
              v-if="arm.state !== 'invalid'"
              type="button"
              :data-testid="`start-${arm.id}`"
              :disabled="!canStart(arm)"
              class="rounded bg-slate-100 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-40"
              @click="requestStart(arm)"
            >
              Start
            </button>
            <button
              v-if="arm.state !== 'invalid'"
              type="button"
              :data-testid="`stop-${arm.id}`"
              :disabled="!canStop(arm)"
              class="rounded border border-slate-600 px-3 py-1 text-sm disabled:opacity-40"
              @click="emit('stop', arm.id)"
            >
              Stop
            </button>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>
