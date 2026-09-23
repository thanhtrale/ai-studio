<script setup lang="ts">
/**
 * The frame every page sits in: brand, navigation, and the arm drawer.
 *
 * The drawer lives here rather than on a route of its own because starting an
 * arm evicts whichever one holds the GPU -- it is something you do to the
 * machine from wherever you are, not a place you navigate to.
 */
import { ref } from 'vue';

import ArmInventory from '../components/ArmInventory.vue';
import UiAlert from '../components/ui/Alert.vue';
import UiBadge from '../components/ui/Badge.vue';
import UiDrawer from '../components/ui/Drawer.vue';

const NAV = [
  { to: '/', label: 'Home' },
  { to: '/generate/image', label: 'Image' },
  { to: '/generate/video', label: 'Video' },
  { to: '/analyze/block', label: 'Analyze' },
  { to: '/library', label: 'Library' },
  { to: '/lan', label: 'LAN' },
] as const;

const { arms, connection, incumbent, refresh } = useArms();
useArmPolling(refresh);
const { busy, failure, operate } = useArmControl(refresh);

const drawer = ref(false);
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-surface text-slate-100">
    <header class="flex items-center gap-6 border-b border-white/10 px-6 py-3">
      <NuxtLink to="/" class="flex items-center gap-2 text-base font-semibold">
        <span class="text-indigo-400">&#9670;</span> AI Studio
      </NuxtLink>

      <nav class="flex items-center gap-1 text-sm">
        <NuxtLink
          v-for="entry in NAV"
          :key="entry.to"
          :to="entry.to"
          class="rounded px-3 py-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
          active-class="bg-white/10 text-slate-100"
        >
          {{ entry.label }}
        </NuxtLink>
      </nav>

      <div class="ml-auto flex items-center gap-3">
        <UiBadge v-if="connection === 'unreachable'" tone="bad">supervisor down</UiBadge>
        <UiBadge v-else-if="incumbent" tone="ok">{{ incumbent.id }}</UiBadge>
        <UiBadge v-else tone="neutral">no arm running</UiBadge>
        <button
          type="button"
          class="rounded px-3 py-1.5 text-sm text-slate-400 hover:bg-white/5 hover:text-slate-100"
          @click="drawer = true"
        >
          Arms
        </button>
      </div>
    </header>

    <!-- Pages own their own scrolling: the library scrolls three panes
         independently, the landing page scrolls as one. -->
    <main class="min-h-0 flex-1 overflow-hidden"><slot /></main>

    <UiDrawer
      :open="drawer"
      title="Arms"
      subtitle="One arm holds the GPU at a time. Starting another stops the one that has it."
      @close="drawer = false"
    >
      <UiAlert v-if="failure" tone="error" class="mb-4">{{ failure }}</UiAlert>
      <ArmInventory
        :arms="arms"
        :connection="connection"
        :busy="busy"
        @start="(id) => operate(id, 'starting')"
        @stop="(id) => operate(id, 'stopping')"
      />
    </UiDrawer>
  </div>
</template>
