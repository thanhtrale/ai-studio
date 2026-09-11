<script setup lang="ts">
/**
 * Full-size preview.
 *
 * It takes the whole list rather than one item so the arrow keys work: looking
 * at a batch of attempts means stepping through them, and closing the viewer to
 * pick the next one is the wrong shape for that.
 */
import { computed, onBeforeUnmount, watch } from 'vue';

import { formatBytes, shortDescription, type MediaItem } from '#shared/library';

import UiButton from './ui/Button.vue';
import UiModal from './ui/Modal.vue';

const props = defineProps<{ item: MediaItem | null; items: readonly MediaItem[] }>();
const emit = defineEmits<{ close: []; navigate: [MediaItem] }>();

const index = computed(() => (props.item ? props.items.findIndex((entry) => entry.id === props.item?.id) : -1));

function step(delta: number): void {
  if (index.value < 0 || props.items.length === 0) return;
  const next = props.items[(index.value + delta + props.items.length) % props.items.length];
  if (next) emit('navigate', next);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') step(1);
  else if (event.key === 'ArrowLeft') step(-1);
}

watch(
  () => props.item,
  (item) => {
    if (!import.meta.client) return;
    if (item) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <UiModal :open="item !== null" size="full" @close="emit('close')">
    <template v-if="item">
      <div class="flex max-h-[78vh] items-center justify-center">
        <img
          v-if="item.kind === 'image'"
          :src="mediaUrl(item.id)"
          :alt="item.name"
          class="max-h-[78vh] max-w-full rounded object-contain"
        />
        <!-- Autoplay is deliberate: opening a clip is a request to watch it. -->
        <video
          v-else
          :key="item.id"
          :src="mediaUrl(item.id)"
          class="max-h-[78vh] max-w-full rounded"
          controls
          autoplay
          loop
        />
      </div>

      <div class="flex w-full items-center justify-between gap-4 rounded bg-black/60 px-4 py-2">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium text-slate-100">{{ item.name }}</p>
          <p class="truncate text-xs text-slate-400">{{ shortDescription(item) }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span class="text-xs text-slate-500">{{ index + 1 }} / {{ items.length }}</span>
          <UiButton size="sm" variant="ghost" aria-label="Previous" @click="step(-1)">&#8592;</UiButton>
          <UiButton size="sm" variant="ghost" aria-label="Next" @click="step(1)">&#8594;</UiButton>
          <a
            :href="mediaUrl(item.id)"
            target="_blank"
            rel="noopener"
            class="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-100"
          >
            Open ({{ formatBytes(item.bytes) }})
          </a>
          <UiButton size="sm" variant="ghost" @click="emit('close')">Close</UiButton>
        </div>
      </div>
    </template>
  </UiModal>
</template>
