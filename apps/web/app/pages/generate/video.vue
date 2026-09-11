<script setup lang="ts">
/**
 * The video console, at its own URL.
 *
 * Two query parameters make it reachable from the library rather than only from
 * the nav: `?from=<media id>` restores the settings of a previous run, and
 * `?reference=<media id>` starts a new one from an image. Both are read from the
 * URL rather than handed over in memory, so the link survives a reload and can
 * be kept.
 */
import { computed } from 'vue';

import GenerateConsole from '../../components/GenerateConsole.vue';

useHead({ title: 'Video' });

const route = useRoute();
const { arms } = useArms();
const { byId } = useMedia();

const restore = computed(() => {
  const from = route.query['from'];
  return typeof from === 'string' ? (byId.value.get(from)?.meta ?? null) : null;
});

const initialReference = computed(() => {
  const wanted = route.query['reference'];
  return typeof wanted === 'string' ? wanted : null;
});
</script>

<template>
  <GenerateConsole :arms="arms" :restore="restore" :initial-reference="initialReference" />
</template>
