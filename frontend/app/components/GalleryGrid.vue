<template>
  <div class="space-y-4">
    <p v-if="pending" class="text-sm text-ink-500">Đang tải gallery…</p>
    <p v-else-if="error" class="text-sm text-red-300">{{ error }}</p>

    <p v-else-if="!items.length" class="rounded-xl border border-dashed border-white/15 px-4 py-10 text-center text-sm text-ink-500">
      Chưa có video nào.
    </p>

    <div v-else class="grid gap-5 sm:grid-cols-2">
      <article v-for="item in items" :key="item.id" class="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
        <video
          v-if="item.modality === 'video'"
          :src="item.media.downloadUrl"
          controls
          preload="metadata"
          class="w-full rounded-lg bg-black"
        />
        <img v-else :src="item.media.downloadUrl" :alt="title(item)" class="w-full rounded-lg bg-black" />

        <div class="space-y-1">
          <p class="text-sm">{{ title(item) }}</p>
          <p class="text-xs text-ink-500">
            {{ jobTypeById(item.typeId)?.label ?? item.typeId }} ·
            {{ item.media.width ?? '?' }}×{{ item.media.height ?? '?' }} ·
            {{ formatBytes(item.media.bytes) }} ·
            {{ Math.round(item.seconds) }}s render ·
            {{ formatDate(new Date(item.createdAt).toISOString()) }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-3 text-xs">
          <a
            :href="item.media.downloadUrl"
            download
            class="rounded-lg border border-white/15 px-2.5 py-1.5 hover:bg-white/10"
          >
            Tải xuống
          </a>
          <a
            v-if="item.logUrl"
            :href="item.logUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="rounded-lg border border-white/15 px-2.5 py-1.5 hover:bg-white/10"
          >
            Log đầy đủ
          </a>
          <button
            type="button"
            class="rounded-lg border border-white/15 px-2.5 py-1.5 text-ink-200 hover:border-red-400/50 hover:text-red-300"
            @click="remove(item.id)"
          >
            Xoá khỏi gallery
          </button>
        </div>

        <details v-if="item.logTail" class="text-xs">
          <summary class="cursor-pointer text-ink-200">Log cuối lượt chạy</summary>
          <pre class="mt-2 max-h-60 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] text-ink-500">{{ item.logTail }}</pre>
        </details>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { jobTypeById, type CloudGalleryDoc } from '@ai-studio/cloud-contract';
import { formatBytes, formatDate } from '~/utils/format';

const { items, pending, error, remove } = useCloudGallery();

function title(item: CloudGalleryDoc): string {
  const prompt = item.values['prompt'];
  return typeof prompt === 'string' && prompt.trim() ? prompt : '(không có prompt)';
}
</script>
