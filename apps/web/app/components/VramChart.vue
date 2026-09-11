<script setup lang="ts">
/**
 * Two meters on one time axis.
 *
 * They are not the same measurement and the chart says so. The machine line is
 * nvidia-smi for the whole card: the desktop, the browser's compositor, and any
 * other process, as well as the arm. The arm line is torch's own reserved figure
 * from inside the arm process. Subtracting one from the other would be
 * meaningless, so the chart shows both and claims nothing about the gap.
 */
import { computed } from 'vue';

import type { VramSample } from '@ai-studio/arm-contract';

const props = withDefaults(
  defineProps<{
    machine: readonly VramSample[];
    arm: readonly VramSample[];
    capacityGib: number | null;
    available?: boolean;
  }>(),
  { available: true },
);

const WIDTH = 600;
const HEIGHT = 130;
const PAD_LEFT = 26;
const PAD_TOP = 8;
const PAD_BOTTOM = 14;

const peak = (samples: readonly VramSample[]): number =>
  samples.reduce((most, sample) => Math.max(most, sample.gib), 0);

const machinePeak = computed(() => peak(props.machine));
const armPeak = computed(() => peak(props.arm));

/** The window both lines are drawn over: whichever of them started first. */
const span = computed(() => {
  const all = [...props.machine, ...props.arm];
  if (all.length === 0) return null;

  const from = all.reduce((least, sample) => Math.min(least, sample.at), Infinity);
  const to = all.reduce((most, sample) => Math.max(most, sample.at), -Infinity);
  // A single sample, or a window under a second: give it width so the line is
  // visible rather than a dot at the left edge.
  return { from, to: Math.max(to, from + 1000) };
});

const ceiling = computed(() => {
  const highest = Math.max(machinePeak.value, armPeak.value);
  const capacity = props.capacityGib ?? 0;
  return Math.max(capacity > 0 ? capacity : highest * 1.15, highest * 1.15, 1);
});

const ticks = computed(() => {
  const top = ceiling.value;
  const stepSize = top > 24 ? 8 : top > 12 ? 4 : top > 6 ? 2 : 1;
  const out: number[] = [];
  for (let value = 0; value <= top; value += stepSize) out.push(value);
  return out;
});

const y = (gib: number): number =>
  HEIGHT - PAD_BOTTOM - (gib / ceiling.value) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

const x = (at: number): number => {
  const window = span.value;
  if (!window) return PAD_LEFT;
  const fraction = (at - window.from) / (window.to - window.from);
  return PAD_LEFT + fraction * (WIDTH - PAD_LEFT - 4);
};

const line = (samples: readonly VramSample[]): string =>
  samples.map((sample) => `${x(sample.at).toFixed(1)},${y(sample.gib).toFixed(1)}`).join(' ');

const machineLine = computed(() => line(props.machine));
const armLine = computed(() => line(props.arm));

const last = (samples: readonly VramSample[]): VramSample | null => samples.at(-1) ?? null;
</script>

<template>
  <section class="rounded-lg border border-white/10 bg-surface-raised p-3">
    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
      <span class="font-medium text-slate-200">VRAM</span>

      <span class="flex items-center gap-1.5 text-slate-400">
        <span class="inline-block h-2 w-2 rounded-sm bg-sky-400" />
        Machine <span class="font-mono text-slate-100">{{ machinePeak.toFixed(2) }}</span> GiB peak ·
        <code class="text-slate-500">nvidia-smi</code>
      </span>

      <span v-if="arm.length > 0" class="flex items-center gap-1.5 text-slate-400">
        <span class="inline-block h-2 w-2 rounded-sm bg-orange-400" />
        Arm <span class="font-mono text-slate-100">{{ armPeak.toFixed(2) }}</span> GiB peak · torch
        reserved
      </span>

      <span v-if="capacityGib" class="ml-auto text-slate-500">/ {{ capacityGib.toFixed(2) }} GiB</span>
    </header>

    <p v-if="!available" class="mt-2 text-xs text-amber-300/80">
      nvidia-smi is not answering, so only the arm's own figure is drawn.
    </p>

    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      class="mt-2 w-full"
      :style="{ height: `${HEIGHT}px` }"
      preserveAspectRatio="none"
      role="img"
      aria-label="GPU memory over time"
    >
      <text :x="2" :y="PAD_TOP + 8" class="fill-slate-600 text-[9px]">GiB</text>

      <g v-for="tick in ticks" :key="tick">
        <line
          :x1="PAD_LEFT"
          :x2="WIDTH - 4"
          :y1="y(tick)"
          :y2="y(tick)"
          class="stroke-white/10"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
        <text :x="2" :y="y(tick) + 3" class="fill-slate-600 text-[9px]">{{ tick }}</text>
      </g>

      <polyline
        v-if="machine.length > 1"
        :points="machineLine"
        fill="none"
        class="stroke-sky-400"
        stroke-width="1.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <polyline
        v-if="arm.length > 1"
        :points="armLine"
        fill="none"
        class="stroke-orange-400"
        stroke-width="1.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />

      <circle
        v-if="last(machine)"
        :cx="x(last(machine)!.at)"
        :cy="y(last(machine)!.gib)"
        r="2.5"
        class="fill-sky-400"
      />
      <circle
        v-if="last(arm)"
        :cx="x(last(arm)!.at)"
        :cy="y(last(arm)!.gib)"
        r="2.5"
        class="fill-orange-400"
      />
    </svg>

    <p class="mt-1 text-[11px] leading-snug text-slate-500">
      Two meters, one axis: the machine line is <code>nvidia-smi</code> for the whole card sampled every
      second, the arm line is torch's own reserved figure inside the arm process — the gap between them is
      not a subtraction.
    </p>
  </section>
</template>
