<script setup lang="ts">
/**
 * A right-hand panel for things you do *to* the machine rather than places you
 * go: starting an arm evicts whichever one holds the GPU, so it never earned a
 * URL of its own the way the library and the consoles did.
 */
import { onBeforeUnmount, watch } from 'vue';

const props = defineProps<{ open: boolean; title: string; subtitle?: string }>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

watch(
  () => props.open,
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
</script>

<template>
  <Teleport v-if="open" to="body">
    <div class="fixed inset-0 z-40 flex justify-end bg-black/60" @click.self="emit('close')">
      <aside class="flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-surface">
        <header class="flex items-start justify-between gap-4 border-b border-white/10 p-6">
          <div>
            <h2 class="text-lg font-semibold text-slate-100">{{ title }}</h2>
            <p v-if="subtitle" class="mt-1 text-sm text-slate-400">{{ subtitle }}</p>
          </div>
          <button
            type="button"
            class="rounded px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            @click="emit('close')"
          >
            Close
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-6"><slot /></div>
      </aside>
    </div>
  </Teleport>
</template>
