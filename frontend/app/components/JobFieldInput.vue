<template>
  <div class="space-y-1.5">
    <label v-if="field.kind !== 'toggle'" class="block text-sm font-medium" :for="id">
      {{ field.label }}
    </label>

    <textarea
      v-if="field.kind === 'textarea'"
      :id="id"
      :value="model as string"
      rows="3"
      :maxlength="field.maxLength"
      :required="field.required"
      class="w-full resize-y rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      @input="emit('update:model', ($event.target as HTMLTextAreaElement).value)"
    />

    <input
      v-else-if="field.kind === 'text'"
      :id="id"
      :value="model as string"
      :maxlength="field.maxLength"
      :required="field.required"
      class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      @input="emit('update:model', ($event.target as HTMLInputElement).value)"
    />

    <input
      v-else-if="field.kind === 'number'"
      :id="id"
      type="number"
      :value="model as number"
      :min="field.min"
      :max="field.max"
      step="any"
      class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      @input="emit('update:model', Number(($event.target as HTMLInputElement).value))"
    />

    <select
      v-else-if="field.kind === 'select'"
      :id="id"
      :value="model as string"
      class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      @change="emit('update:model', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in field.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>

    <label v-else class="flex items-center gap-2 text-sm">
      <input
        :id="id"
        type="checkbox"
        class="size-4"
        :checked="model as boolean"
        @change="emit('update:model', ($event.target as HTMLInputElement).checked)"
      />
      <span>{{ field.label }}</span>
    </label>

    <p v-if="field.help" class="text-xs text-ink-500">{{ field.help }}</p>
  </div>
</template>

<script setup lang="ts">
import type { JobField } from '@ai-studio/cloud-contract';

const props = defineProps<{ field: JobField; model: unknown }>();
const emit = defineEmits<{ 'update:model': [value: unknown] }>();

const id = computed(() => `field-${props.field.name}`);
</script>
