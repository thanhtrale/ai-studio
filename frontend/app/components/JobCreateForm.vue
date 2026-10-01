<template>
  <form class="space-y-5 rounded-xl border border-white/10 bg-white/5 p-5" @submit.prevent="onSubmit">
    <div class="space-y-2">
      <label class="block text-sm font-medium" for="prompt">Prompt</label>
      <textarea
        id="prompt"
        v-model="prompt"
        rows="3"
        required
        placeholder="Mô tả cảnh cần tạo"
        class="w-full resize-y rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      />
    </div>

    <div class="space-y-2">
      <label class="block text-sm font-medium" for="negative">Negative prompt</label>
      <input
        id="negative"
        v-model="negativePrompt"
        placeholder="Thứ cần tránh (tuỳ chọn)"
        class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-white/40"
      />
    </div>

    <fieldset class="space-y-3">
      <legend class="text-sm font-medium">Ảnh tham chiếu</legend>
      <div class="flex flex-wrap items-center gap-3">
        <label
          class="cursor-pointer rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
          :class="{ 'pointer-events-none opacity-40': refs.uploading.value }"
        >
          {{ refs.uploading.value ? 'Đang tải lên…' : 'Tải ảnh lên' }}
          <input type="file" accept="image/*" class="hidden" @change="onPickReference" />
        </label>
        <button
          type="button"
          class="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
          @click="refs.refresh"
        >
          Ảnh đã dùng
        </button>
        <button
          v-if="reference"
          type="button"
          class="text-sm text-ink-500 hover:text-red-300"
          @click="reference = null"
        >
          Bỏ chọn
        </button>
      </div>

      <p v-if="refs.error.value" class="text-sm text-red-300">{{ refs.error.value }}</p>

      <div v-if="reference" class="flex items-center gap-3 rounded-lg border border-white/15 p-3">
        <img :src="reference.downloadUrl" :alt="reference.name" class="h-16 w-16 rounded object-cover" />
        <div class="min-w-0 text-sm">
          <p class="truncate">{{ reference.name }}</p>
          <p class="text-xs text-ink-500">
            {{ reference.width ?? '?' }}×{{ reference.height ?? '?' }} · {{ formatBytes(reference.bytes) }}
          </p>
        </div>
      </div>

      <div v-if="refs.items.value.length" class="flex flex-wrap gap-2">
        <button
          v-for="item in refs.items.value"
          :key="item.storagePath"
          type="button"
          class="rounded border p-0.5"
          :class="item.storagePath === reference?.storagePath ? 'border-white' : 'border-white/15 hover:border-white/40'"
          :title="item.name"
          @click="reference = item"
        >
          <img :src="item.downloadUrl" :alt="item.name" class="h-14 w-14 rounded object-cover" />
        </button>
      </div>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-3">
      <legend class="mb-2 text-sm font-medium">Thiết lập</legend>

      <label class="space-y-1 text-sm">
        <span class="text-ink-200">Khung hình</span>
        <select v-model="resolution" class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none">
          <option v-for="option in RESOLUTIONS" :key="option.label" :value="option.label">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="space-y-1 text-sm">
        <span class="text-ink-200">Độ dài (giây)</span>
        <input
          v-model.number="settings.seconds"
          type="number"
          min="1"
          max="20"
          step="1"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none"
        />
      </label>

      <label class="space-y-1 text-sm">
        <span class="text-ink-200">FPS</span>
        <input
          v-model.number="settings.frameRate"
          type="number"
          min="8"
          max="60"
          step="1"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none"
        />
      </label>

      <label class="space-y-1 text-sm">
        <span class="text-ink-200">Seed (-1 = ngẫu nhiên)</span>
        <input
          v-model.number="settings.seed"
          type="number"
          class="w-full rounded-lg border border-white/15 bg-ink-950 px-3 py-2 outline-none"
        />
      </label>

      <label class="flex items-center gap-2 pt-6 text-sm">
        <input v-model="settings.enhancePrompt" type="checkbox" class="size-4" />
        <span>Enhance prompt</span>
      </label>

      <label class="flex items-center gap-2 pt-6 text-sm">
        <input v-model="settings.spatialUpsample" type="checkbox" class="size-4" />
        <span>Upsample không gian</span>
      </label>
    </fieldset>

    <p v-if="error" class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {{ error }}
    </p>

    <div class="flex items-center gap-3">
      <button
        type="submit"
        class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-ink-950 hover:bg-ink-200 disabled:opacity-40"
        :disabled="busy || !prompt.trim()"
      >
        {{ busy ? 'Đang gửi…' : 'Tạo job' }}
      </button>
      <span v-if="!workerOnline" class="text-sm text-amber-300">
        Worker đang offline — job sẽ nằm chờ tới khi bật máy local.
      </span>
    </div>
  </form>
</template>

<script setup lang="ts">
import { DEFAULT_VIDEO_SETTINGS, type CloudJobReference, type CloudVideoSettings } from '@ai-studio/cloud-contract';
import { formatBytes } from '~/utils/format';

const props = defineProps<{
  workerOnline: boolean;
  submit: (input: {
    prompt: string;
    negativePrompt: string;
    settings: CloudVideoSettings;
    reference: CloudJobReference | null;
  }) => Promise<string>;
}>();

const RESOLUTIONS = [
  { label: '1216×704 (16:9)', width: 1216, height: 704 },
  { label: '704×1216 (9:16)', width: 704, height: 1216 },
  { label: '960×960 (1:1)', width: 960, height: 960 },
];

const refs = useReferenceLibrary();

const prompt = ref('');
const negativePrompt = ref('');
const reference = ref<CloudJobReference | null>(null);
const resolution = ref(RESOLUTIONS[0]!.label);
const settings = reactive<CloudVideoSettings>({ ...DEFAULT_VIDEO_SETTINGS });
const busy = ref(false);
const error = ref<string | null>(null);

async function onPickReference(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    const uploaded = await refs.upload(file);
    if (uploaded) reference.value = uploaded;
  }
  input.value = '';
}

async function onSubmit() {
  busy.value = true;
  error.value = null;
  try {
    const picked = RESOLUTIONS.find((option) => option.label === resolution.value) ?? RESOLUTIONS[0]!;
    await props.submit({
      prompt: prompt.value.trim(),
      negativePrompt: negativePrompt.value.trim(),
      settings: { ...settings, width: picked.width, height: picked.height },
      reference: reference.value,
    });
    prompt.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>
