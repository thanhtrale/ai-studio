<script setup lang="ts">
/**
 * One row of the timeline, and whatever it contains.
 *
 * Recursive because the work is: a generation has phases, a phase has the load
 * it triggered and the sampler steps it counted out. Depth only changes the
 * type size and the indent, so a nested step still reads as the same kind of
 * thing as the one above it.
 */
import type { JobStep } from '@ai-studio/arm-contract';

defineProps<{ step: JobStep; depth: number }>();

const GLYPH: Record<JobStep['state'], string> = {
  pending: '○',
  running: '◍',
  done: '✓',
  failed: '✕',
};

const TONE: Record<JobStep['state'], string> = {
  pending: 'text-slate-600',
  running: 'text-indigo-300',
  done: 'text-emerald-400',
  failed: 'text-rose-400',
};

const BADGE: Record<JobStep['state'], string> = {
  pending: 'bg-white/5 text-slate-500',
  running: 'bg-indigo-500/15 text-indigo-300',
  done: 'bg-white/5 text-slate-500',
  failed: 'bg-rose-500/15 text-rose-300',
};

/** Seconds read at a glance: `2m 47s` beats `167.4 s` for anything this long. */
function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)
    .toString()
    .padStart(2, '0')}s`;
}
</script>

<template>
  <li class="space-y-1">
    <div class="flex items-baseline gap-2" :class="depth === 0 ? 'text-sm' : 'text-xs'">
      <span class="w-3 shrink-0" :class="TONE[step.state]">{{ GLYPH[step.state] }}</span>
      <span :class="depth === 0 ? 'text-slate-200' : 'text-slate-400'">{{ step.label }}</span>
      <span
        v-if="depth === 0 && step.state !== 'pending'"
        class="rounded px-1 text-[10px]"
        :class="BADGE[step.state]"
      >
        {{ step.state }}
      </span>
      <span v-if="step.detail" class="min-w-0 truncate text-xs text-slate-500">{{ step.detail }}</span>
      <span class="ml-auto shrink-0 font-mono text-xs text-slate-400">{{ duration(step.seconds) }}</span>
    </div>

    <div v-if="step.note" class="ml-5 rounded border border-white/10 bg-black/30 p-2 text-xs">
      <p v-if="step.noteReplaces" class="text-slate-600 line-through">{{ step.noteReplaces }}</p>
      <p class="mt-1 leading-snug text-slate-300">{{ step.note }}</p>
    </div>

    <ol v-if="step.children?.length" class="ml-5 space-y-0.5 border-l border-white/5 pl-2">
      <JobTimelineStep
        v-for="child in step.children"
        :key="child.key"
        :step="child"
        :depth="depth + 1"
      />
    </ol>
  </li>
</template>
