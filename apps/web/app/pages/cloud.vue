<template>
  <section class="mx-auto max-w-4xl space-y-6 p-6">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Cloud worker</h1>
        <p class="text-sm opacity-60">Nhận job từ Firebase và chạy trên máy này</p>
      </div>

      <div class="flex items-center gap-3">
        <span class="rounded-full border px-3 py-1 text-xs">{{ stateLabel }}</span>
        <button
          v-if="data?.state !== 'running'"
          type="button"
          class="rounded-lg border px-3 py-2 text-sm"
          :disabled="busy || data?.configured === false"
          @click="start"
        >
          Bật worker
        </button>
        <button v-else type="button" class="rounded-lg border px-3 py-2 text-sm" :disabled="busy" @click="stop">
          Tắt worker
        </button>
      </div>
    </header>

    <p v-if="data && !data.configured" class="rounded-lg border border-amber-500/40 px-4 py-3 text-sm">
      Chưa cấu hình. Đặt <code>AISTUDIO_FIREBASE_SERVICE_ACCOUNT</code> và
      <code>AISTUDIO_FIREBASE_STORAGE_BUCKET</code> trong <code>.env</code> rồi khởi động lại.
    </p>

    <p v-if="data?.error" class="rounded-lg border border-red-500/40 px-4 py-3 text-sm">{{ data.error }}</p>

    <section class="space-y-2">
      <h2 class="text-sm font-medium opacity-70">Hàng đợi</h2>
      <p v-if="!data?.jobs?.length" class="rounded-lg border border-dashed px-4 py-8 text-center text-sm opacity-50">
        Chưa có job nào.
      </p>
      <ul v-else class="divide-y rounded-lg border">
        <li v-for="job in data.jobs" :key="job.id" class="flex items-start gap-3 px-4 py-3">
          <span class="mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-xs">{{ job.status }}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">{{ job.prompt }}</p>
            <p class="text-xs opacity-50">
              {{ job.settings.width }}×{{ job.settings.height }} · {{ job.settings.seconds }}s ·
              {{ job.createdBy.email ?? job.createdBy.uid }}
              <template v-if="job.progress"> · {{ job.progress.label }}</template>
            </p>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="data?.log?.length" class="space-y-2">
      <h2 class="text-sm font-medium opacity-70">Nhật ký worker</h2>
      <pre class="max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs">{{ data.log.join('\n') }}</pre>
    </section>
  </section>
</template>

<script setup lang="ts">
useHead({ title: 'Cloud worker' });

const busy = ref(false);
const { data, refresh } = await useFetch('/api/cloud/worker', { server: false });

const stateLabel = computed(() => {
  const state = data.value?.state;
  if (state === 'running') return 'Đang chạy';
  if (state === 'starting') return 'Đang bật';
  if (state === 'error') return 'Lỗi';
  return 'Đã tắt';
});

async function start() {
  busy.value = true;
  try {
    await $fetch('/api/cloud/worker/start', { method: 'POST' });
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function stop() {
  busy.value = true;
  try {
    await $fetch('/api/cloud/worker/stop', { method: 'POST' });
    await refresh();
  } finally {
    busy.value = false;
  }
}

// The worker reports by polling; there is no socket back from Nitro.
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => void refresh(), 2000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>
