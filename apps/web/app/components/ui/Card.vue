<script setup lang="ts">
withDefaults(defineProps<{ interactive?: boolean; selected?: boolean }>(), {
  interactive: false,
  selected: false,
});
</script>

<template>
  <div
    class="rounded-lg border bg-surface-raised transition-colors"
    :class="[
      selected ? 'border-indigo-400/70' : 'border-white/10',
      interactive ? 'cursor-pointer hover:border-white/30' : '',
    ]"
  >
    <slot />
  </div>
</template>
