<script setup lang="ts">
/**
 * One run's outputs, full size, for review: a sheet and its views, a mesh and
 * its close-ups, a rig and its clips -- stepped through with ← / →.
 *
 * The original reference sits beside whatever is shown (toggle with R),
 * because a sheet or a face is judged against THE ORIGINAL, never against a
 * general idea of a good one. A click on an image toggles fit / actual size:
 * the faults that fail a mesh do not show at fit-to-screen size either.
 *
 * GLBs open in the same three.js viewer a page would use, so a rig plays its
 * clips here as it will on the web.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type { Char3dReviewItem } from '../../utils/char3dReview';
import ModelViewer from '../ModelViewer.vue';
import UiButton from '../ui/Button.vue';
import UiModal from '../ui/Modal.vue';

const props = defineProps<{
  charId: string;
  /** The character's original reference, relative to the character. */
  reference?: string;
  items: readonly Char3dReviewItem[];
  /** The key of the item shown; null when closed. */
  current: string | null;
  /** A heading for the whole list, e.g. the run id. */
  heading?: string;
}>();
const emit = defineEmits<{ close: []; navigate: [key: string] }>();

const file = (rel?: string): string => (rel ? `/api/char3d/${props.charId}/file/${rel}` : '');
const index = computed(() => props.items.findIndex((item) => item.key === props.current));
const item = computed(() => props.items[index.value] ?? null);

const showReference = ref(true);
const actualSize = ref(false);
watch(() => props.current, () => (actualSize.value = false));

function step(delta: number): void {
  if (!props.items.length || index.value < 0) return;
  const next = props.items[(index.value + delta + props.items.length) % props.items.length];
  if (next) emit('navigate', next.key);
}

function onKeydown(event: KeyboardEvent): void {
  // The model viewer's clip select takes arrows too; leave form controls alone.
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
  if (event.key === 'ArrowRight') step(1);
  else if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'r' || event.key === 'R') showReference.value = !showReference.value;
}

watch(
  () => props.current !== null,
  (open) => {
    if (!import.meta.client) return;
    if (open) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener('keydown', onKeydown);
});

// Keep the active thumbnail in view as the arrows move through a long rig list.
const strip = ref<HTMLDivElement | null>(null);
watch(index, () => {
  if (!import.meta.client) return;
  requestAnimationFrame(() => strip.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
});
</script>

<template>
  <UiModal :open="item !== null" size="full" @close="emit('close')">
    <template v-if="item">
      <div class="flex w-[92vw] flex-col gap-2">
        <div class="flex h-[72vh] gap-2">
          <div class="relative min-w-0 flex-1 overflow-auto rounded bg-white/5">
            <div v-if="item.kind === 'model'" class="h-full w-full">
              <ModelViewer :key="item.file" :src="file(item.file)" :bytes="item.bytes" />
            </div>
            <div v-else class="flex min-h-full min-w-full items-center justify-center" :class="actualSize ? 'cursor-zoom-out' : 'cursor-zoom-in'">
              <img
                :src="file(item.file)"
                :alt="item.title"
                class="rounded bg-white"
                :class="actualSize ? 'max-w-none' : 'max-h-[72vh] max-w-full object-contain'"
                @click="actualSize = !actualSize"
              />
            </div>
          </div>
          <div v-if="showReference && reference" class="flex w-56 shrink-0 flex-col gap-1">
            <p class="text-xs text-slate-400">Original reference</p>
            <img :src="file(reference)" alt="Original reference" class="max-h-[68vh] w-full rounded bg-white object-contain" />
          </div>
        </div>

        <div ref="strip" class="flex gap-1 overflow-x-auto pb-1">
          <button
            v-for="entry in items"
            :key="entry.key"
            type="button"
            class="relative h-14 w-14 shrink-0 overflow-hidden rounded border-2 bg-white"
            :class="entry.key === item.key ? 'border-indigo-400' : entry.warn ? 'border-amber-400/70' : 'border-transparent opacity-70 hover:opacity-100'"
            :data-active="entry.key === item.key"
            :title="entry.title"
            @click="emit('navigate', entry.key)"
          >
            <span v-if="entry.kind === 'model'" class="flex h-full items-center justify-center bg-slate-800 text-[10px] font-semibold text-indigo-200">3D</span>
            <img v-else :src="file(entry.file)" alt="" class="h-full w-full object-contain" loading="lazy" />
          </button>
        </div>

        <div class="flex w-full flex-wrap items-center justify-between gap-3 rounded bg-black/60 px-4 py-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-slate-100">
              <span v-if="heading" class="font-mono text-slate-400">{{ heading }} · </span>{{ item.title }}
            </p>
            <p v-if="item.caption" class="truncate text-xs" :class="item.warn ? 'text-amber-300' : 'text-slate-400'">{{ item.caption }}</p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <slot name="actions" :item="item" />
            <span class="text-xs text-slate-500">{{ index + 1 }} / {{ items.length }}</span>
            <UiButton size="sm" variant="ghost" aria-label="Previous" @click="step(-1)">&#8592;</UiButton>
            <UiButton size="sm" variant="ghost" aria-label="Next" @click="step(1)">&#8594;</UiButton>
            <UiButton v-if="reference" size="sm" variant="ghost" :active="showReference" title="Show the original reference (R)" @click="showReference = !showReference">
              Original
            </UiButton>
            <a :href="file(item.file)" target="_blank" rel="noopener" class="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-100">Open</a>
            <UiButton size="sm" variant="ghost" @click="emit('close')">Close</UiButton>
          </div>
        </div>
      </div>
    </template>
  </UiModal>
</template>
