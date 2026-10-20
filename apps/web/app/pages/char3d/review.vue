<script setup lang="ts">
/** The animation review page became the 3D gallery; old links keep working. */
const route = useRoute();
await navigateTo({ path: '/char3d/gallery', query: route.query }, { redirectCode: 301, replace: true });
</script>

<template>
  <div />
</template>
