<script setup lang="ts">
const model = defineModel<string>({ required: true });

withDefaults(defineProps<{ id?: string; rows?: number; placeholder?: string }>(), { rows: 4 });
</script>

<template>
  <textarea
    :id="id"
    v-model="model"
    :rows="rows"
    :placeholder="placeholder"
    class="w-full rounded border border-white/15 bg-surface-raised p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
  />
</template>
