<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { ConnectionState, PendingOperation } from '../types';
import UiAlert from './ui/Alert.vue';
import UiBadge from './ui/Badge.vue';
import UiButton from './ui/Button.vue';
import UiCard from './ui/Card.vue';

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

const tone = (arm: ArmSummary): 'ok' | 'bad' | 'warn' | 'neutral' => {
  switch (stateLabel(arm)) {
    case 'running':
      return 'ok';
    case 'failed':
    case 'invalid':
      return 'bad';
    case 'starting':
    case 'stopping':
      return 'warn';
    default:
      return 'neutral';
  }
};
</script>

<template>
  <section class="space-y-4">
    <p v-if="connection === 'loading'" data-testid="connection-loading" class="text-sm text-slate-400">
      Contacting the supervisor…
    </p>

    <UiAlert
      v-else-if="connection === 'unreachable'"
      data-testid="supervisor-unavailable"
      tone="warn"
      title="Supervisor unavailable"
    >
      <p class="mt-1 text-sm text-amber-100/80">
        Arm state is unknown while the supervisor is down. Start it with
        <code class="rounded bg-black/30 px-1">npm run dev</code>; this view recovers on its own.
      </p>
    </UiAlert>

    <template v-else>
      <UiAlert v-if="pendingEviction" data-testid="eviction-confirm" tone="warn">
        <p class="text-sm text-amber-100">
          Starting <strong>{{ pendingEviction.requested.id }}</strong> will stop
          <strong>{{ pendingEviction.incumbent.id }}</strong> to free the GPU.
        </p>
        <div class="mt-3 flex gap-2">
          <UiButton
            size="sm"
            variant="primary"
            data-testid="eviction-confirm-button"
            @click="confirmEviction"
          >
            Stop it and continue
          </UiButton>
          <UiButton size="sm" data-testid="eviction-cancel-button" @click="pendingEviction = null">
            Cancel
          </UiButton>
        </div>
      </UiAlert>

      <p v-if="arms.length === 0" data-testid="empty" class="text-sm text-slate-400">
        No arms discovered under <code>arms/</code>.
      </p>

      <ul class="grid gap-3">
        <li v-for="arm in arms" :key="arm.id">
          <UiCard :data-testid="`arm-${arm.id}`">
            <div class="p-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="font-medium text-slate-100">{{ arm.id }}</h3>
                  <p class="text-sm text-slate-400">
                    {{ arm.modality ?? 'unknown modality' }}
                    <span v-if="arm.lifecycle"> · {{ arm.lifecycle }}</span>
                  </p>
                </div>
                <UiBadge :data-testid="`state-${arm.id}`" :tone="tone(arm)">{{ stateLabel(arm) }}</UiBadge>
              </div>

              <p v-if="arm.detail" :data-testid="`detail-${arm.id}`" class="mt-2 text-sm text-rose-300">
                {{ arm.detail }}
              </p>

              <div class="mt-3 flex gap-2">
                <UiButton
                  v-if="arm.state !== 'invalid'"
                  size="sm"
                  :data-testid="`start-${arm.id}`"
                  :disabled="!canStart(arm)"
                  @click="requestStart(arm)"
                >
                  Start
                </UiButton>
                <UiButton
                  v-if="arm.state !== 'invalid'"
                  size="sm"
                  variant="ghost"
                  :data-testid="`stop-${arm.id}`"
                  :disabled="!canStop(arm)"
                  @click="emit('stop', arm.id)"
                >
                  Stop
                </UiButton>
              </div>
            </div>
          </UiCard>
        </li>
      </ul>
    </template>
  </section>
</template>
