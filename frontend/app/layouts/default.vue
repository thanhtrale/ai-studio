<template>
  <div class="min-h-dvh flex flex-col">
    <header class="border-b border-white/10">
      <nav class="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
        <NuxtLink to="/" class="font-semibold tracking-tight">AI Studio</NuxtLink>
        <NuxtLink
          v-for="item in links"
          :key="item.to"
          :to="item.to"
          class="text-sm text-ink-200 hover:text-white"
          active-class="text-white"
        >
          {{ item.label }}
        </NuxtLink>
      </nav>
    </header>

    <main class="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <slot />
    </main>

    <footer class="border-t border-white/10 px-6 py-6 text-xs text-ink-500">
      Static build · Firebase Hosting
    </footer>
  </div>
</template>

<script setup lang="ts">
const links = [
  { to: '/files', label: 'Thư viện' },
  { to: '/p2p', label: 'P2P' },
  { to: '/about', label: 'Giới thiệu' },
];
</script>
