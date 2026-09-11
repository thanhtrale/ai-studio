<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h2 class="truncate text-base font-semibold text-slate-100">{{ title }}</h2>
      <p v-if="subtitle || $slots.subtitle" class="mt-0.5 text-sm text-slate-400">
        <slot name="subtitle">{{ subtitle }}</slot>
      </p>
    </div>
    <div class="shrink-0"><slot name="actions" /></div>
  </div>
</template>
