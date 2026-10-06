<script setup lang="ts">
/**
 * The rig console, at its own URL. `?mesh=<media id>` starts from a mesh,
 * `?from=<media id>` restores a previous rig's settings.
 */
import { computed } from 'vue';

import RigConsole from '../../components/RigConsole.vue';

useHead({ title: 'Rig' });

const route = useRoute();
const { arms } = useArms();
const { byId } = useMedia();

const restore = computed(() => {
  const from = route.query['from'];
  return typeof from === 'string' ? (byId.value.get(from)?.meta ?? null) : null;
});
const initialMesh = computed(() => {
  const wanted = route.query['mesh'];
  return typeof wanted === 'string' ? wanted : null;
});
</script>

<template>
  <RigConsole :arms="arms" :restore="restore" :initial-mesh="initialMesh" />
</template>
