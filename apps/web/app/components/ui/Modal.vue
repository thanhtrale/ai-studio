<script setup lang="ts">
/**
 * One overlay for every modal in the studio: the media picker, the preview
 * lightbox, confirmations.
 *
 * Closing is deliberately available three ways -- the button, the backdrop and
 * Escape -- because the lightbox is opened casually and dismissed constantly.
 */
import { onBeforeUnmount, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    subtitle?: string;
    /** `full` is for the lightbox: chrome-free, sized by its content. */
    size?: 'md' | 'lg' | 'full';
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ close: [] }>();

const WIDTHS = { md: 'w-full max-w-lg', lg: 'w-full max-w-4xl', full: 'max-h-[92vh] max-w-[92vw]' } as const;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (open) => {
    if (!import.meta.client) return;
    if (open) {
      window.addEventListener('keydown', onKeydown);
      // The page behind a modal must not scroll under it; the lightbox in
      // particular is arrow-key driven and would otherwise move both.
      document.body.style.overflow = 'hidden';
    } else {
      window.removeEventListener('keydown', onKeydown);
      document.body.style.overflow = '';
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (!import.meta.client) return;
  window.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport v-if="open" to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      @click.self="emit('close')"
    >
      <div
        v-if="size === 'full'"
        :class="WIDTHS[size]"
        class="flex flex-col items-center gap-3"
        @click.stop
      >
        <slot />
      </div>

      <div
        v-else
        :class="WIDTHS[size]"
        class="flex max-h-[85vh] flex-col rounded-lg border border-white/10 bg-surface shadow-2xl"
        @click.stop
      >
        <header v-if="title" class="flex items-start justify-between gap-4 border-b border-white/10 p-4">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-slate-100">{{ title }}</h2>
            <p v-if="subtitle" class="mt-0.5 text-sm text-slate-400">{{ subtitle }}</p>
          </div>
          <button
            type="button"
            class="rounded px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="Close"
            @click="emit('close')"
          >
            &#10005;
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-4"><slot /></div>

        <footer v-if="$slots.footer" class="border-t border-white/10 p-4">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
