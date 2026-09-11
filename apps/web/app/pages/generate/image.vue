<script setup lang="ts">
/**
 * The image console, at its own URL.
 *
 * The same two query parameters as the video page, so a link from the library
 * means the same thing on both: `?from=<media id>` restores the settings of a
 * previous run, `?reference=<media id>` starts a new one from an image.
 */
import { computed } from 'vue';

import ImageConsole from '../../components/ImageConsole.vue';

useHead({ title: 'Image' });

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
  <ImageConsole :arms="arms" :restore="restore" :initial-reference="initialReference" />
</template>
