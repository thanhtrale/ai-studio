<script setup lang="ts">
/**
 * What the job is doing, in the order it does it.
 *
 * Deliberately one flat list of the studio's own steps rather than a spinner: on
 * this machine a clip is minutes long and almost all of it is one of three
 * things -- weights crossing PCIe, the enhancer writing, the denoising loop --
 * and a progress bar alone cannot tell those apart, nor any of them from a hang.
 */
import { computed } from 'vue';

import type { JobProgress } from '@ai-studio/arm-contract';

import JobTimelineStep from './JobTimelineStep.vue';

const props = defineProps<{ job: JobProgress | null; elapsedSeconds: number }>();

/** Seconds read at a glance: `2m 47s` beats `167.4 s` for anything this long. */
function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)
    .toString()
    .padStart(2, '0')}s`;
}

const heading = computed(() => {
  const state = props.job?.state;
  if (state === 'failed') return 'Failed';
  if (state === 'done') return 'Done';
  if (state === 'running') return 'Running';
  return 'Queued';
});

const tone = computed(() =>
  props.job?.state === 'failed'
    ? 'text-rose-300'
    : props.job?.state === 'done'
      ? 'text-slate-200'
      : 'text-indigo-300',
);
</script>

<template>
  <section v-if="job" class="space-y-3" data-testid="job-timeline">
    <header class="flex items-baseline justify-between gap-4">
      <h2 class="text-lg font-semibold" :class="tone">{{ heading }}</h2>
      <span class="font-mono text-lg" :class="tone">{{ duration(elapsedSeconds) }}</span>
    </header>

    <div v-for="meter in job.meters" :key="meter.key" class="space-y-1">
      <div class="flex items-baseline justify-between gap-3 text-sm">
        <span class="font-medium text-slate-200">
          {{ meter.label }}
          <span v-if="meter.detail" class="font-normal text-slate-500">{{ meter.detail }}</span>
        </span>
        <span class="font-mono text-xs text-slate-400">{{ meter.done }} / {{ meter.total }}</span>
      </div>
      <div class="h-1 overflow-hidden rounded bg-white/10">
        <div
          class="h-full rounded bg-indigo-400 transition-[width] duration-500"
          :style="{ width: `${Math.min(100, (meter.done / Math.max(1, meter.total)) * 100)}%` }"
        />
      </div>
    </div>

    <p v-if="job.detail" class="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
      {{ job.detail }}
    </p>

    <ol class="space-y-1.5 border-l border-white/10 pl-3">
      <JobTimelineStep v-for="step in job.steps" :key="step.key" :step="step" :depth="0" />
    </ol>
  </section>
</template>
