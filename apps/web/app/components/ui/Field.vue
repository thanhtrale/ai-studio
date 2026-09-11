<script setup lang="ts">
/**
 * Label, control, hint -- in that order, with one spacing rule.
 *
 * The hint slot exists because most controls here need one: the model rejects
 * sizes and frame counts the form is free to offer, so the form has to say what
 * it will actually send.
 */
defineProps<{ label: string; for?: string; required?: boolean; hint?: string }>();
</script>

<template>
  <div class="space-y-1">
    <label class="block text-sm font-medium text-slate-200" :for="$props.for">
      {{ label }}<span v-if="required" class="text-rose-400"> *</span>
    </label>
    <slot />
    <p v-if="hint || $slots.hint" class="text-xs text-slate-500">
      <slot name="hint">{{ hint }}</slot>
    </p>
  </div>
</template>
