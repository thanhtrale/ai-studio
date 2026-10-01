<template>
  <div class="space-y-3">
    <p v-if="pending" class="text-sm text-ink-500">Đang tải danh sách job…</p>

    <p v-else-if="!jobs.length" class="rounded-xl border border-dashed border-white/15 px-4 py-10 text-center text-sm text-ink-500">
      Chưa có job nào.
    </p>

    <ul v-else class="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
      <li v-for="job in jobs" :key="job.id" class="space-y-2 bg-white/5 px-4 py-3">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs" :class="badge(job.status)">
            {{ STATUS_LABEL[job.status] }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">{{ jobTitle(job) }}</p>
            <p class="text-xs text-ink-500">
              {{ jobTypeById(job.typeId)?.label ?? job.typeId }} ·
              {{ summarise(job) }} ·
              {{ formatDate(new Date(job.createdAt).toISOString()) }}
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <button
              v-if="ACTIVE_JOB_STATUSES.includes(job.status)"
              type="button"
              class="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:border-amber-400/50 hover:text-amber-300"
              @click="cancel(job.id)"
            >
              Huỷ
            </button>
            <button
              v-else
              type="button"
              class="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-ink-200 hover:border-red-400/50 hover:text-red-300"
              @click="remove(job.id)"
            >
              Xoá
            </button>
          </div>
        </div>

        <div v-if="job.progress && job.status === 'running'" class="space-y-1">
          <p class="text-xs text-ink-200">
            {{ job.progress.label }}
            <span v-if="job.progress.detail" class="text-ink-500">· {{ job.progress.detail }}</span>
          </p>
          <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              class="h-full bg-white transition-all"
              :style="{ width: `${Math.round((job.progress.fraction ?? 0) * 100)}%` }"
            />
          </div>
        </div>

        <p v-if="job.error" class="text-xs text-red-300">{{ job.error }}</p>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import {
  ACTIVE_JOB_STATUSES,
  jobTitle,
  jobTypeById,
  type CloudJobDoc,
  type CloudJobStatus,
} from '@ai-studio/cloud-contract';
import { formatDate } from '~/utils/format';

defineProps<{
  jobs: CloudJobDoc[];
  pending: boolean;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}>();

/** The two or three numbers worth showing without knowing which arm ran. */
function summarise(job: CloudJobDoc): string {
  const parts: string[] = [];
  const { width, height, numFrames, batch } = job.values as Record<string, number | undefined>;
  if (width && height) parts.push(`${width}×${height}`);
  if (numFrames) parts.push(`${numFrames} khung`);
  if (batch && batch > 1) parts.push(`×${batch}`);
  return parts.join(' · ') || '—';
}

const STATUS_LABEL: Record<CloudJobStatus, string> = {
  queued: 'Chờ',
  claimed: 'Đã nhận',
  running: 'Đang chạy',
  done: 'Xong',
  failed: 'Lỗi',
  canceled: 'Đã huỷ',
};

function badge(status: CloudJobStatus): string {
  if (status === 'done') return 'bg-emerald-400/15 text-emerald-300';
  if (status === 'failed') return 'bg-red-500/15 text-red-300';
  if (status === 'running') return 'bg-sky-400/15 text-sky-300';
  if (status === 'canceled') return 'bg-white/10 text-ink-500';
  return 'bg-amber-400/15 text-amber-300';
}
</script>
