<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import type { ArmSummary, InventoryResponse } from '@ai-studio/arm-contract';

import ArmInventory from './components/ArmInventory.vue';
import GenerateConsole from './components/GenerateConsole.vue';
import type { ConnectionState, PendingOperation } from './types';

const POLL_INTERVAL_MS = 1500;

const arms = ref<ArmSummary[]>([]);
const connection = ref<ConnectionState>('loading');
const busy = ref<Record<string, PendingOperation>>({});
const lastError = ref<string | null>(null);
const showArms = ref(false);

let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  try {
    const inventory = await $fetch<InventoryResponse>('/api/arms');
    arms.value = inventory.arms;
    connection.value = 'connected';
  } catch {
    connection.value = 'unreachable';
  }
}

async function operate(armId: string, operation: PendingOperation): Promise<void> {
  busy.value = { ...busy.value, [armId]: operation };
  lastError.value = null;

  try {
    await $fetch(`/api/arms/${encodeURIComponent(armId)}/${operation === 'starting' ? 'start' : 'stop'}`, {
      method: 'POST',
      body: operation === 'starting' ? { params: {} } : undefined,
    });
  } catch (error) {
    const data = (error as { data?: { data?: { message?: string } } }).data?.data;
    lastError.value = data?.message ?? (error as Error).message;
  } finally {
    const { [armId]: _removed, ...rest } = busy.value;
    busy.value = rest;
    await refresh();
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="min-h-screen bg-surface text-slate-100">
    <GenerateConsole :arms="arms" @settings="showArms = true" />

    <!--
      The arm pane is a drawer rather than a route: starting an arm evicts whichever
      one holds the GPU, so it is a thing you do to the machine, not a place you go.
    -->
    <div
      v-if="showArms"
      class="fixed inset-0 z-10 flex justify-end bg-black/60"
      @click.self="showArms = false"
    >
      <div class="h-full w-[36rem] overflow-y-auto border-l border-white/10 bg-surface p-6">
        <header class="mb-6 flex items-start justify-between">
          <div>
            <h2 class="text-lg font-semibold">Arms</h2>
            <p class="text-sm text-slate-400">
              One arm holds the GPU at a time. Starting another stops the one that has it.
            </p>
          </div>
          <button
            type="button"
            class="rounded px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            @click="showArms = false"
          >
            Close
          </button>
        </header>

        <p
          v-if="lastError"
          class="mb-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"
        >
          {{ lastError }}
        </p>

        <ArmInventory
          :arms="arms"
          :connection="connection"
          :busy="busy"
          @start="(id) => operate(id, 'starting')"
          @stop="(id) => operate(id, 'stopping')"
        />
      </div>
    </div>
  </div>
</template>
