<script setup lang="ts">
const model = defineModel<boolean>({ required: true });

defineProps<{ label: string; hint?: string }>();
</script>

<template>
  <div class="space-y-1">
    <label class="flex items-center gap-2 text-sm text-slate-200">
      <input v-model="model" type="checkbox" class="accent-indigo-500" />
      {{ label }}
    </label>
    <p v-if="hint || $slots.hint" class="pl-6 text-xs text-slate-500">
      <slot name="hint">{{ hint }}</slot>
    </p>
  </div>
</template>
