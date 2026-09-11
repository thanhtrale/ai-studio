<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ tone?: 'error' | 'success' | 'warn' | 'info'; title?: string }>(), {
  tone: 'info',
});

const TONES = {
  error: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  info: 'border-white/15 bg-surface-raised text-slate-300',
} as const;

const classes = computed(() => TONES[props.tone]);
</script>

<template>
  <div class="rounded border p-3 text-sm" :class="classes">
    <p v-if="title" class="font-medium">{{ title }}</p>
    <slot />
  </div>
</template>
