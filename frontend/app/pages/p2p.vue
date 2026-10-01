<template>
  <section class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Truyền tệp P2P</h1>
      <p class="text-sm text-ink-500">WebRTC data channel · Firestore làm signaling</p>
    </header>

    <div class="flex flex-wrap items-center gap-3">
      <span class="rounded-full border border-white/15 px-3 py-1 text-xs">
        {{ phaseLabel }}
      </span>
      <span v-if="connectionState" class="rounded-full border border-white/15 px-3 py-1 text-xs text-ink-200">
        ICE: {{ connectionState }}
      </span>
      <button
        type="button"
        class="rounded-full border border-white/15 px-3 py-1 text-xs text-ink-200 hover:bg-white/10"
        @click="probeIce"
      >
        Kiểm tra ICE
      </button>
    </div>

    <p v-if="error" class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {{ error }}
    </p>

    <div v-if="phase === 'idle' || phase === 'failed'" class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-3 rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 class="font-medium">Máy A — tạo phòng</h2>
        <p class="text-sm text-ink-200">Tạo mã rồi đọc mã đó sang máy kia.</p>
        <button
          type="button"
          class="rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200"
          @click="createRoom"
        >
          Tạo phòng
        </button>
      </div>

      <form class="space-y-3 rounded-xl border border-white/10 bg-white/5 p-5" @submit.prevent="onJoin">
        <h2 class="font-medium">Máy B — vào phòng</h2>
        <input
          v-model="code"
          placeholder="Mã 6 ký tự"
          maxlength="6"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 font-mono uppercase tracking-widest outline-none focus:border-white/40"
        />
        <button
          type="submit"
          class="rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200 disabled:opacity-40"
          :disabled="code.length < 6"
        >
          Kết nối
        </button>
      </form>
    </div>

    <div v-else class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 p-5">
        <div>
          <p class="text-xs uppercase tracking-wider text-ink-500">Mã phòng</p>
          <p class="font-mono text-3xl tracking-[0.3em]">{{ roomId }}</p>
        </div>
        <button
          type="button"
          class="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
          @click="hangUp"
        >
          Ngắt
        </button>
      </div>

      <div class="rounded-xl border border-white/10 bg-white/5 p-5">
        <label
          class="inline-block cursor-pointer rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200"
          :class="{ 'pointer-events-none opacity-40': phase !== 'connected' || !!sending }"
        >
          Chọn tệp để gửi
          <input type="file" class="hidden" @change="onPick" />
        </label>
        <p v-if="phase !== 'connected'" class="mt-2 text-sm text-ink-500">
          Đang chờ máy kia kết nối…
        </p>

        <div v-if="sending" class="mt-4 space-y-1">
          <p class="text-sm">Đang gửi {{ sending.name }} — {{ percent(sending) }}%</p>
          <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-white transition-all" :style="{ width: `${percent(sending)}%` }" />
          </div>
        </div>

        <div v-if="receiving" class="mt-4 space-y-1">
          <p class="text-sm">
            Đang nhận {{ receiving.name }} — {{ percent(receiving) }}%
            <span class="text-ink-500">({{ storingOnDisk ? 'ghi xuống đĩa' : 'giữ trong RAM' }})</span>
          </p>
          <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-emerald-400 transition-all" :style="{ width: `${percent(receiving)}%` }" />
          </div>
        </div>
      </div>

      <div v-if="received.length" class="space-y-2">
        <h2 class="text-sm font-medium text-ink-200">Đã nhận</h2>
        <ul class="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
          <li v-for="file in received" :key="file.id" class="flex items-center gap-4 bg-white/5 px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{{ file.name }}</p>
              <p class="text-xs text-ink-500">
                {{ formatBytes(file.size) }} · {{ file.onDisk ? 'trên đĩa' : 'trong RAM' }}
              </p>
            </div>
            <a
              :href="file.url"
              :download="file.name"
              class="shrink-0 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/10"
            >
              Tải xuống
            </a>
            <button
              type="button"
              class="shrink-0 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-ink-200 hover:border-red-400/50 hover:text-red-300"
              @click="discard(file.id)"
            >
              Xoá
            </button>
          </li>
        </ul>
      </div>
    </div>

    <details v-if="events.length" class="rounded-xl border border-white/10 bg-white/5 p-4">
      <summary class="cursor-pointer text-sm text-ink-200">Nhật ký ({{ events.length }})</summary>
      <ul class="mt-3 space-y-1 font-mono text-xs text-ink-500">
        <li v-for="(line, index) in events" :key="index">{{ line }}</li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { formatBytes } from '~/utils/format';
import type { Progress } from '~/composables/useWebRtcTransfer';

useHead({ title: 'P2P · AI Studio' });

const code = ref('');
const {
  phase,
  roomId,
  error,
  events,
  connectionState,
  received,
  sending,
  receiving,
  storingOnDisk,
  createRoom,
  joinRoom,
  sendFile,
  discard,
  probeIce,
  hangUp,
} = useWebRtcTransfer();

const labels: Record<string, string> = {
  idle: 'Chưa kết nối',
  hosting: 'Đang chờ máy kia',
  joining: 'Đang bắt tay',
  connected: 'Đã kết nối',
  closed: 'Đã đóng',
  failed: 'Thất bại',
};

const phaseLabel = computed(() => labels[phase.value] ?? phase.value);

function percent(progress: Progress): number {
  return progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
}

async function onJoin() {
  await joinRoom(code.value);
}

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await sendFile(file);
  input.value = '';
}
</script>
