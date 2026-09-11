<script setup lang="ts">
/** Separate from Input because `v-model.number` is a modifier a wrapper cannot forward. */
const model = defineModel<number>({ required: true });

defineProps<{ id?: string; min?: number; max?: number; step?: number }>();
</script>

<template>
  <input
    :id="id"
    v-model.number="model"
    type="number"
    :min="min"
    :max="max"
    :step="step"
    class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
  />
</template>
