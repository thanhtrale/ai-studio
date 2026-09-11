<script setup lang="ts">
const model = defineModel<string>({ required: true });

withDefaults(defineProps<{ id?: string; placeholder?: string }>(), {});
</script>

<template>
  <input
    :id="id"
    v-model="model"
    type="text"
    :placeholder="placeholder"
    class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
  />
</template>
