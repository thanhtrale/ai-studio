<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import type { ArmSummary, InventoryResponse } from '@ai-studio/arm-contract';

import ArmInventory from './components/ArmInventory.vue';
import type { ConnectionState, PendingOperation } from './types';

const POLL_INTERVAL_MS = 1500;

const arms = ref<ArmSummary[]>([]);
const connection = ref<ConnectionState>('loading');
const busy = ref<Record<string, PendingOperation>>({});
const lastError = ref<string | null>(null);

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
    <div class="mx-auto max-w-3xl p-8">
      <header class="mb-6">
        <h1 class="text-xl font-semibold">ai-studio</h1>
        <p class="text-sm text-slate-400">
          One arm holds the GPU at a time. Starting another stops the one that has it.
        </p>
      </header>

      <p v-if="lastError" class="mb-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
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
</template>
