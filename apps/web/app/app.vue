<script setup lang="ts">
useHead({
  titleTemplate: (title) => (title ? `${title} · AI Studio` : 'AI Studio'),
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
