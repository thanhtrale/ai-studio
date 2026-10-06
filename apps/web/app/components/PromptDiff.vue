<script setup lang="ts">
/**
 * A prompt before and after the enhancer, as one text with the changes marked.
 *
 * Inline rather than side by side: a rewrite reorders and reshapes more than
 * it edits, and two columns of a few hundred words each would leave the reader
 * matching lines by eye. Added words are highlighted; removed ones stay where
 * they were, greyed and struck through, so the old sense is still readable in
 * place.
 */
import { computed } from 'vue';

import { diffStats, diffWords } from '../utils/diff';

const props = defineProps<{ before: string; after: string }>();

const parts = computed(() => diffWords(props.before, props.after));
const stats = computed(() => diffStats(parts.value));
</script>

<template>
  <div class="space-y-2" data-testid="prompt-diff">
    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      <span><span class="text-emerald-300">+{{ stats.added }}</span> words added</span>
      <span><span class="text-slate-400">−{{ stats.removed }}</span> words removed</span>
      <span class="ml-auto flex items-center gap-3">
        <span class="rounded bg-emerald-500/20 px-1 text-emerald-200">added</span>
        <span class="text-slate-500 line-through grayscale">removed</span>
      </span>
    </p>
    <p
      v-if="parts.length"
      class="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-3 text-sm leading-relaxed text-slate-300"
    >
      <template v-for="(part, index) in parts" :key="index">
        <span
          v-if="part.kind === 'added'"
          class="rounded-sm bg-emerald-500/20 text-emerald-200"
          data-diff="added"
        >{{ part.text }}</span>
        <span
          v-else-if="part.kind === 'removed'"
          class="text-slate-500 line-through decoration-slate-500/70 opacity-70 grayscale"
          data-diff="removed"
        >{{ part.text }}</span>
        <span v-else>{{ part.text }}</span>
      </template>
    </p>
    <p v-else class="text-xs text-slate-500">Both are empty.</p>
  </div>
</template>
