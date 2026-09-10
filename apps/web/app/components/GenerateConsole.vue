<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import {
  ASPECTS,
  latentTokens,
  resolveDuration,
  resolveFrame,
  resolveOutput,
  type Aspect,
} from '../utils/frame';

const props = defineProps<{ arms: ArmSummary[] }>();
const emit = defineEmits<{ settings: [] }>();

/** Only video arms can take a generation job; the rest are other modalities. */
const videoArms = computed(() => props.arms.filter((arm) => arm.modality === 'video'));
const armId = ref<string>('');

watch(
  videoArms,
  (list) => {
    if (!armId.value && list[0]) armId.value = list[0].id;
  },
  { immediate: true },
);

const arm = computed(() => videoArms.value.find((candidate) => candidate.id === armId.value) ?? null);
const running = computed(() => arm.value?.state === 'running');

const prompt = ref('');
const image = ref('');
const aspect = ref<Aspect>('16:9');
const megapixels = ref(0.5);
const seconds = ref(5);
const fps = ref(24);
const seed = ref('');
const enhancePrompt = ref(false);
const spatialUpsample = ref(false);
const temporalUpsample = ref(false);

const frame = computed(() => resolveFrame(aspect.value, megapixels.value));
const duration = computed(() => resolveDuration(seconds.value, fps.value));
const output = computed(() =>
  resolveOutput(frame.value, duration.value, fps.value, spatialUpsample.value, temporalUpsample.value),
);
const tokens = computed(() => latentTokens(frame.value.width, frame.value.height, duration.value.numFrames));

const status = ref<'idle' | 'generating'>('idle');
const failure = ref<string | null>(null);
/** The arm's own report, verbatim. Its keys are the arm's, not the console's. */
interface GenerationReport {
  seconds_total: number;
  seed: number;
  out_path: string;
  out_bytes: number;
  peak_vram_reserved_gib: number;
  stages: { name: string; seconds: number; peak_vram_gib: number; spill_gib: number }[];
}

const result = ref<GenerationReport | null>(null);

const canGenerate = computed(() => running.value && prompt.value.trim().length > 0 && status.value === 'idle');

async function generate(): Promise<void> {
  if (!canGenerate.value || !arm.value) return;

  status.value = 'generating';
  failure.value = null;
  result.value = null;

  const typed = seed.value.trim();
  const chosenSeed = typed === '' ? -1 : Number(typed);

  try {
    result.value = await $fetch<GenerationReport>(
      `/api/arms/${encodeURIComponent(arm.value.id)}/generate`,
      {
        method: 'POST',
        body: {
          prompt: prompt.value.trim(),
          outPath: `${Date.now()}.mp4`,
          width: frame.value.width,
          height: frame.value.height,
          numFrames: duration.value.numFrames,
          frameRate: fps.value,
          seed: Number.isFinite(chosenSeed) ? chosenSeed : -1,
          ...(image.value.trim() ? { image: image.value.trim() } : {}),
          enhancePrompt: enhancePrompt.value,
          spatialUpsample: spatialUpsample.value,
          temporalUpsample: temporalUpsample.value,
        },
      },
    );
  } catch (error) {
    const data = (error as { data?: { data?: { message?: string } } }).data?.data;
    failure.value = data?.message ?? (error as Error).message;
  } finally {
    status.value = 'idle';
  }
}

const number = (value: number): string => value.toLocaleString('en-US');
</script>

<template>
  <div class="flex min-h-screen bg-surface text-slate-100">
    <aside class="w-96 shrink-0 space-y-5 overflow-y-auto border-r border-white/10 p-6">
      <header class="flex items-center justify-between">
        <h1 class="flex items-center gap-2 text-base font-semibold">
          <span class="text-indigo-400">&#9670;</span> AI Studio
        </h1>
        <button
          type="button"
          class="rounded px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
          title="Arms and processes"
          @click="emit('settings')"
        >
          Arms
        </button>
      </header>

      <p
        class="rounded bg-surface-raised py-2 text-center text-xs"
        :class="status === 'generating' ? 'text-amber-300' : 'text-slate-400'"
      >
        {{ status === 'generating' ? 'generating' : running ? 'idle' : 'arm not running' }}
      </p>

      <div class="space-y-1">
        <label class="text-sm font-medium" for="arm">Arm</label>
        <select id="arm" v-model="armId" class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm">
          <option v-for="candidate in videoArms" :key="candidate.id" :value="candidate.id">
            {{ candidate.name }}
          </option>
        </select>
        <p class="text-xs text-slate-500">text-to-video, image-to-video, 8 distilled steps</p>
      </div>

      <div class="space-y-1">
        <label class="flex items-center gap-2 text-sm">
          <input v-model="enhancePrompt" type="checkbox" class="accent-indigo-500" />
          Prompt enhancer
        </label>
        <p class="text-xs text-slate-500">
          The repository&#39;s own Gemma, 9.51 GiB, loaded for the jobs that ask and freed again.
        </p>
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">Frame</legend>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label class="text-xs text-slate-400" for="aspect">Aspect</label>
            <select
              id="aspect"
              v-model="aspect"
              class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm"
            >
              <option v-for="option in ASPECTS" :key="option" :value="option">{{ option }}</option>
            </select>
          </div>
          <div class="space-y-1">
            <label class="text-xs text-slate-400" for="megapixels">Megapixels</label>
            <input
              id="megapixels"
              v-model.number="megapixels"
              type="number"
              min="0.05"
              max="4"
              step="0.05"
              class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm"
            />
          </div>
        </div>
        <p class="text-xs text-slate-500">
          <span class="text-slate-300">{{ frame.width }}&#215;{{ frame.height }}</span>
          &middot; {{ frame.megapixels.toFixed(2) }} MP &middot; actual ratio {{ frame.ratio.toFixed(2) }}
        </p>
      </fieldset>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">Duration</legend>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label class="text-xs text-slate-400" for="seconds">Seconds</label>
            <input
              id="seconds"
              v-model.number="seconds"
              type="number"
              min="0.5"
              max="20"
              step="0.5"
              class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm"
            />
          </div>
          <div class="space-y-1">
            <label class="text-xs text-slate-400" for="fps">FPS</label>
            <input
              id="fps"
              v-model.number="fps"
              type="number"
              min="8"
              max="60"
              class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm"
            />
          </div>
        </div>
        <p class="text-xs text-slate-500">
          <span class="text-slate-300">{{ duration.numFrames }}</span> frames &middot;
          {{ duration.seconds.toFixed(2) }} s actual
        </p>
      </fieldset>

      <div class="space-y-1">
        <label class="text-sm font-medium" for="seed">Seed</label>
        <input
          id="seed"
          v-model="seed"
          placeholder="empty = random"
          class="w-full rounded border border-white/15 bg-surface-raised p-2 text-sm"
        />
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">Upsamplers</legend>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="spatialUpsample" type="checkbox" class="accent-indigo-500" />
          Spatial (&#215;2 edge)
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="temporalUpsample" type="checkbox" class="accent-indigo-500" />
          Temporal (&#215;2 frames, same duration)
        </label>
        <p class="text-xs text-slate-500">
          Lightricks&#39; own latent upsamplers. Each runs a further denoising round on what it
          upsampled, so the model redraws detail rather than interpolating it.
        </p>
      </fieldset>

      <div class="space-y-1 border-t border-white/10 pt-4 text-xs text-slate-500">
        <p><span class="text-slate-300">{{ number(tokens) }}</span> latent tokens</p>
        <p>
          output <span class="text-slate-300">{{ output.width }}&#215;{{ output.height }}</span>
          &middot; {{ output.numFrames }} frames &middot; {{ output.fps.toFixed(1) }} fps &middot;
          {{ output.seconds.toFixed(2) }} s
        </p>
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto p-8">
      <div class="max-w-3xl space-y-5">
        <div class="space-y-1">
          <label class="text-sm font-medium" for="prompt">
            Prompt <span class="text-rose-400">*</span>
          </label>
          <textarea
            id="prompt"
            v-model="prompt"
            rows="5"
            placeholder="Describe the scene, the motion, the light"
            class="w-full rounded border border-white/15 bg-surface-raised p-3 text-sm"
          />
          <p class="text-xs text-slate-500">
            The model was trained on long single-paragraph audio-visual captions and degrades on
            short prompts. The enhancer rewrites a short one into that style.
          </p>
        </div>

        <div class="space-y-1">
          <label class="text-sm font-medium" for="image">Reference image</label>
          <input
            id="image"
            v-model="image"
            placeholder="a file inside the arm&#39;s inputs directory, for example frame.png"
            class="w-full rounded border border-white/15 bg-surface-raised p-3 text-sm"
          />
          <p class="text-xs text-slate-500">
            An image switches the run to image-to-video. Upload is not wired yet, so this names a
            file already in that directory.
          </p>
        </div>

        <div class="flex items-center gap-3">
          <button
            type="button"
            :disabled="!canGenerate"
            class="rounded bg-indigo-500 px-5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
            @click="generate"
          >
            {{ status === 'generating' ? 'Generating' : 'Generate' }}
          </button>
          <p v-if="!running" class="text-xs text-slate-500">Start the arm from the Arms pane first.</p>
        </div>

        <p v-if="failure" class="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {{ failure }}
        </p>
        <p
          v-if="result"
          class="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
        >
          {{ result.out_path }} &middot; {{ result.seconds_total.toFixed(1) }} s &middot;
          {{ number(result.out_bytes) }} bytes &middot; seed {{ result.seed }} &middot; peak
          {{ result.peak_vram_reserved_gib.toFixed(2) }} GiB
          <span v-for="entry in result.stages" :key="entry.name" class="ml-2 text-emerald-300/70">
            {{ entry.name }} {{ entry.seconds.toFixed(1) }}s
          </span>
        </p>
      </div>
    </main>
  </div>
</template>
