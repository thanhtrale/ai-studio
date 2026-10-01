<template>
  <section class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Gallery</h1>
      <p class="text-sm text-ink-500">Video đã gen xong, kèm log của lượt chạy</p>
    </header>

    <SignInGate>
      <GalleryGrid />
    </SignInGate>
  </section>
</template>

<script setup lang="ts">
useHead({ title: 'Gallery · AI Studio' });
</script>
