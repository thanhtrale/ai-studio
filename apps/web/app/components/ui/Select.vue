<script setup lang="ts">
export interface SelectOption {
  value: string;
  label: string;
}

const model = defineModel<string>({ required: true });

defineProps<{ id?: string; options: readonly SelectOption[] }>();
</script>

<template>
  <select
    :id="id"
    v-model="model"
    class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
  >
    <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
  </select>
</template>
