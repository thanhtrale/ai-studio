<script setup lang="ts">
/** Every clickable thing in the studio, so the affordance reads the same everywhere. */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md';
    type?: 'button' | 'submit';
    disabled?: boolean;
    /** Renders as pressed, for controls that hold a state rather than fire once. */
    active?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', disabled: false, active: false },
);

const VARIANTS = {
  primary: 'bg-indigo-500 text-white hover:bg-indigo-400',
  secondary: 'border border-white/15 bg-surface-raised text-slate-100 hover:border-white/30',
  ghost: 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
  danger: 'border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20',
} as const;

const SIZES = { sm: 'px-2 py-1 text-xs', md: 'px-4 py-2 text-sm' } as const;

const classes = computed(() => [
  'inline-flex items-center justify-center gap-2 rounded font-medium transition-colors',
  'disabled:cursor-not-allowed disabled:opacity-40',
  VARIANTS[props.variant],
  SIZES[props.size],
  props.active ? 'ring-1 ring-indigo-400' : '',
]);
</script>

<template>
  <button :type="type" :disabled="disabled" :class="classes">
    <slot />
  </button>
</template>
