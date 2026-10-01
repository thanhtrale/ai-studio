<template>
  <section class="space-y-4">
    <h1 class="text-2xl font-semibold tracking-tight">Giới thiệu</h1>
    <dl class="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
      <dt class="text-ink-500">Framework</dt>
      <dd>Nuxt 4 · Vue 3 · Tailwind CSS 4</dd>
      <dt class="text-ink-500">Build</dt>
      <dd><code>nuxt generate</code> → <code>.output/public</code></dd>
      <dt class="text-ink-500">Lưu trữ</dt>
      <dd>Firebase Storage, truy cập từ trình duyệt</dd>
      <dt class="text-ink-500">Hosting</dt>
      <dd>Firebase Hosting (static)</dd>
    </dl>
  </section>
</template>

<script setup lang="ts">
useHead({ title: 'Giới thiệu · AI Studio' });
</script>
