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

        <div class="ml-auto flex items-center gap-3 text-sm">
          <template v-if="user">
            <span class="hidden text-ink-500 sm:inline">{{ user.email }}</span>
            <button type="button" class="text-ink-200 hover:text-white" @click="signOut">Đăng xuất</button>
          </template>
          <button v-else-if="ready" type="button" class="text-ink-200 hover:text-white" @click="signIn">
            Đăng nhập
          </button>
        </div>
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
const { user, ready, signIn, signOut } = useAuth();

const links = [
  { to: '/jobs', label: 'Jobs' },
  { to: '/gallery', label: 'Gallery' },
  { to: '/files', label: 'Thư viện' },
  { to: '/p2p', label: 'P2P' },
];
</script>
