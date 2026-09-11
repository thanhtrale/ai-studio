<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ tone?: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' }>(), {
  tone: 'neutral',
});

const TONES = {
  ok: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  bad: 'bg-rose-500/15 text-rose-300',
  neutral: 'bg-slate-500/15 text-slate-300',
  accent: 'bg-indigo-500/15 text-indigo-300',
} as const;

const classes = computed(() => TONES[props.tone]);
</script>

<template>
  <span class="rounded px-2 py-1 text-xs" :class="classes">
    <slot />
  </span>
</template>
