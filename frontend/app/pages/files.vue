<template>
  <section class="space-y-6">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Thư viện</h1>
        <p class="text-sm text-ink-500">Firebase Storage · {{ prefix }}/</p>
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40"
          :disabled="pending"
          @click="refresh"
        >
          Làm mới
        </button>
        <label
          class="cursor-pointer rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200"
          :class="{ 'pointer-events-none opacity-40': uploading }"
        >
          Tải lên
          <input type="file" class="hidden" :disabled="uploading" @change="onPick" />
        </label>
      </div>
    </header>

    <div v-if="uploading" class="h-1.5 overflow-hidden rounded-full bg-white/10">
      <div class="h-full bg-white transition-all" :style="{ width: `${progress}%` }" />
    </div>

    <p v-if="error" class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {{ error }}
    </p>

    <p v-if="pending" class="text-sm text-ink-500">Đang tải danh sách…</p>

    <p v-else-if="!files.length" class="rounded-xl border border-dashed border-white/15 px-4 py-10 text-center text-sm text-ink-500">
      Chưa có tệp nào.
    </p>

    <ul v-else class="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
      <li v-for="file in files" :key="file.path" class="flex items-center gap-4 bg-white/5 px-4 py-3">
        <div class="min-w-0 flex-1">
          <a :href="file.url" target="_blank" rel="noopener noreferrer" class="block truncate font-medium hover:underline">
            {{ file.name }}
          </a>
          <p class="text-xs text-ink-500">
            {{ formatBytes(file.size) }} · {{ file.contentType }} · {{ formatDate(file.updatedAt) }}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-ink-200 hover:border-red-400/50 hover:text-red-300"
          @click="remove(file.path)"
        >
          Xoá
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { formatBytes, formatDate } from '~/utils/format';

useHead({ title: 'Thư viện · AI Studio' });

const prefix = useRuntimeConfig().public.storagePrefix;
const { files, pending, uploading, progress, error, refresh, upload, remove } = useFirebaseStorage();

onMounted(refresh);

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await upload(file);
  input.value = '';
}
</script>
