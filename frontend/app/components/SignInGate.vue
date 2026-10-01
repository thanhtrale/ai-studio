<template>
  <div v-if="!ready" class="rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-ink-500">
    Đang kiểm tra đăng nhập…
  </div>

  <div v-else-if="!user" class="space-y-4 rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center">
    <p class="text-sm text-ink-200">Cần đăng nhập Google để tạo và xem job.</p>
    <button
      type="button"
      class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200 disabled:opacity-40"
      :disabled="busy"
      @click="signIn"
    >
      Đăng nhập với Google
    </button>
    <p v-if="error" class="text-sm text-red-300">{{ error }}</p>
  </div>

  <slot v-else />
</template>

<script setup lang="ts">
const { user, ready, error, busy, signIn } = useAuth();
</script>
