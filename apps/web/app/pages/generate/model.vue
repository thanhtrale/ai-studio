<script setup lang="ts">
/**
 * The 3D console, at its own URL.
 *
 * The same query parameters as the image and video pages: `?from=<media id>`
 * restores the settings of a previous run, `?reference=<media id>` starts a new
 * one from an image.
 */
import { computed } from 'vue';

import ModelConsole from '../../components/ModelConsole.vue';

useHead({ title: '3D' });

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
  <ModelConsole :arms="arms" :restore="restore" :initial-reference="initialReference" />
</template>
