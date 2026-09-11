<script setup lang="ts">
/**
 * A batch, opened.
 *
 * One job that asked for several images wrote several files, and the library
 * shows them as one card so a batch of eight does not bury everything else in
 * the folder. This is what that card opens into: the same grid, holding only
 * the images of that job, in the order the job made them.
 *
 * It is a window over the library rather than a place of its own. Selection and
 * preview are emitted to the page, so the detail panel behind it and the
 * lightbox above it are the ones already on screen -- and closing this leaves
 * the selection it made.
 */
import { computed } from 'vue';

import { formatBytes, isImageSettings, type MediaItem } from '#shared/library';

import MediaThumb from './MediaThumb.vue';
import UiModal from './ui/Modal.vue';

const props = defineProps<{ items: readonly MediaItem[] | null; selectedId?: string | null }>();
const emit = defineEmits<{ close: []; select: [MediaItem]; preview: [MediaItem] }>();

const first = computed(() => props.items?.[0] ?? null);

/** What the job asked for, which is not always what survives on disk. */
const asked = computed(() => {
  const settings = first.value?.meta?.settings;
  return isImageSettings(settings) ? settings.batch : null;
});

const subtitle = computed(() => {
  const items = props.items;
  if (!items || items.length === 0) return '';

  const parts = [`${items.length} image${items.length === 1 ? '' : 's'}`];
  // Said only when they differ: a batch whose files are all still there does
  // not need to be told that they are.
  if (asked.value !== null && asked.value !== items.length) parts.push(`of a batch of ${asked.value}`);

  const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
  parts.push(formatBytes(bytes));

  const prompt = first.value?.meta?.prompt;
  return prompt ? `${parts.join(' · ')} — ${prompt}` : parts.join(' · ');
});

function seedOf(item: MediaItem): number | null {
  const settings = item.meta?.settings;
  return isImageSettings(settings) ? settings.seed : null;
}
</script>

<template>
  <UiModal
    :open="items !== null && items.length > 0"
    size="lg"
    title="Batch"
    :subtitle="subtitle"
    @close="emit('close')"
  >
    <ul v-if="items" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <li v-for="(item, index) in items" :key="item.id">
        <button
          type="button"
          :data-testid="`stack-item-${item.id}`"
          class="w-full overflow-hidden rounded-lg border text-left transition-colors"
          :class="selectedId === item.id ? 'border-indigo-400' : 'border-white/10 hover:border-white/30'"
          @click="emit('select', item)"
          @dblclick="emit('preview', item)"
        >
          <div class="relative aspect-square">
            <MediaThumb :item="item" />
            <span
              class="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-none text-slate-300"
            >
              {{ index + 1 }}
            </span>
          </div>
          <div class="space-y-0.5 p-2">
            <p class="truncate text-xs font-medium text-slate-200">{{ item.name }}</p>
            <p class="truncate text-[11px] text-slate-500">
              <!-- The seed is what tells one image of a batch from another: every
                   other setting in the record is the same for all of them. -->
              {{ seedOf(item) === null ? formatBytes(item.bytes) : `seed ${seedOf(item)}` }}
            </p>
          </div>
        </button>
      </li>
    </ul>

    <template #footer>
      <p class="text-xs text-slate-500">
        Click an image to select it, double-click to open it full size. Every image keeps the whole
        request, with the seed it was made from.
      </p>
    </template>
  </UiModal>
</template>
