<template>
  <section class="space-y-8">
    <div class="space-y-3">
      <h1 class="text-3xl font-semibold tracking-tight">AI Studio</h1>
      <p class="max-w-2xl text-ink-200">
        Frontend tĩnh cho AI Studio. Tài nguyên đọc/ghi trực tiếp từ Firebase Storage,
        không qua server trung gian.
      </p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <NuxtLink
        v-for="card in cards"
        :key="card.to"
        :to="card.to"
        class="rounded-xl border border-white/10 bg-white/5 p-5 transition hover:border-white/25 hover:bg-white/10"
      >
        <h2 class="font-medium">{{ card.title }}</h2>
        <p class="mt-1 text-sm text-ink-200">{{ card.description }}</p>
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
useHead({ title: 'AI Studio' });

const cards = [
  { to: '/files', title: 'Thư viện', description: 'Tải lên, xem và xoá tệp trong Firebase Storage.' },
  { to: '/about', title: 'Giới thiệu', description: 'Kiến trúc build và cách deploy.' },
];
</script>
