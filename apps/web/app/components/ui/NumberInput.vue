<script setup lang="ts">
/**
 * Separate from Input because `v-model.number` is a modifier a wrapper cannot
 * forward.
 *
 * `lazy` commits on blur or Enter rather than on every keystroke. It exists for
 * fields that drive each other: typing `1024` into a linked width would
 * otherwise be seen as 1, then 10, then 102, each one dragging the height
 * somewhere else before the number is finished.
 */
import { ref, watch } from 'vue';

const model = defineModel<number>({ required: true });

const props = withDefaults(
  defineProps<{ id?: string; min?: number; max?: number; step?: number; lazy?: boolean }>(),
  { lazy: false },
);

/** The text actually in the box while it is being typed into. */
const draft = ref(`${model.value}`);
watch(model, (value) => (draft.value = `${value}`));

function commit(): void {
  const parsed = Number(draft.value);
  if (Number.isFinite(parsed)) model.value = parsed;
  // Put back what the model holds: a rejected or adjusted value has to be
  // visible, not silently left as whatever was typed.
  else draft.value = `${model.value}`;
}
</script>

<template>
  <input
    v-if="props.lazy"
    :id="id"
    v-model="draft"
    type="number"
    :min="min"
    :max="max"
    :step="step"
    class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
    @change="commit"
    @blur="commit"
    @keydown.enter="commit"
  />
  <input
    v-else
    :id="id"
    v-model.number="model"
    type="number"
    :min="min"
    :max="max"
    :step="step"
    class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none"
  />
</template>
