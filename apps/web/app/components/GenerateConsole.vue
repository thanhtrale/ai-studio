<script setup lang="ts">
/**
 * The video console: settings, the work, and what the machine is doing with it.
 *
 * Three columns, because they answer three different questions and only the
 * middle one is input. The right-hand column is what makes a minutes-long run
 * bearable: it says which of load, enhance, encode or denoise is happening, and
 * what the card holds while it happens.
 *
 * Nobody starts an arm here. A job names the arm and the configuration it needs
 * and the supervisor brokers the card into that state -- so the only thing the
 * Generate button waits for is a prompt.
 */
import { computed, ref, watch } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { ArmGenerationReport, GenerateRequest, GenerateResponse } from '#shared/generate';
import { formatBytes, type JobSettings, type MediaItem, type MediaMeta } from '#shared/library';

import {
  ASPECTS,
  latentTokens,
  resolveDuration,
  resolveFrame,
  resolveOutput,
  type Aspect,
  type Duration,
  type Frame,
} from '../utils/frame';
import JobTimeline from './JobTimeline.vue';
import MediaPicker from './MediaPicker.vue';
import MediaThumb from './MediaThumb.vue';
import VramChart from './VramChart.vue';
import UiAlert from './ui/Alert.vue';
import UiBadge from './ui/Badge.vue';
import UiButton from './ui/Button.vue';
import UiCheckbox from './ui/Checkbox.vue';
import UiField from './ui/Field.vue';
import UiInput from './ui/Input.vue';
import UiNumberInput from './ui/NumberInput.vue';
import UiSelect from './ui/Select.vue';
import UiTextarea from './ui/Textarea.vue';

const props = defineProps<{
  arms: ArmSummary[];
  /** A previous run to restore, from `?from=` on the page. */
  restore?: MediaMeta | null;
  /** An image to condition on, from `?reference=` on the page. */
  initialReference?: string | null;
}>();

/** Only video arms can take one of these jobs; the rest are other modalities. */
const videoArms = computed(() => props.arms.filter((arm) => arm.modality === 'video'));
const armId = ref<string>('');

watch(
  videoArms,
  (list) => {
    if (!armId.value && list[0]) armId.value = list[0].id;
  },
  { immediate: true },
);

const armOptions = computed(() => videoArms.value.map((arm) => ({ value: arm.id, label: arm.name })));
const arm = computed(() => videoArms.value.find((candidate) => candidate.id === armId.value) ?? null);

/**
 * What each offload setting actually does, in the words of the measurements.
 *
 * The values come from the arm's own parameter schema rather than a list here,
 * so an arm offering different ones is not misrepresented; only the wording is
 * ours, and a value with no wording keeps its raw name.
 */
const OFFLOAD_LABELS: Record<string, string> = {
  'group-stream': 'stream — overlapped, from host RAM',
  group: 'group — host RAM, no overlap',
  'group-disk': 'disk — weights on NVMe',
  model: 'model — whole components at a time',
  sequential: 'sequential — one submodule at a time',
  none: 'none — everything resident',
};

interface SchemaEnum {
  enum?: string[];
  default?: string;
}

const offloadSchema = computed<SchemaEnum | null>(() => {
  const properties = (arm.value?.paramsSchema as { properties?: Record<string, SchemaEnum> } | null)
    ?.properties;
  return properties?.['offload'] ?? null;
});

const offloadOptions = computed(() =>
  (offloadSchema.value?.enum ?? []).map((value) => ({ value, label: OFFLOAD_LABELS[value] ?? value })),
);

const offload = ref<string>('');
watch(
  offloadSchema,
  (schema) => {
    if (!offload.value && schema?.default) offload.value = schema.default;
  },
  { immediate: true },
);

const prompt = ref('');
const referenceId = ref<string | null>(null);
// Held as a plain string because the shared Select speaks strings; the narrow
// union is applied where the arithmetic needs it.
const aspect = ref<string>('16:9');
const megapixels = ref(0.5);
const seconds = ref(5);
const fps = ref(24);
const seed = ref('');
const enhancePrompt = ref(false);
const spatialUpsample = ref(false);
const temporalUpsample = ref(false);

const picking = ref(false);
const { byId, refresh: refreshMedia } = useMedia();
const reference = computed(() => (referenceId.value ? (byId.value.get(referenceId.value) ?? null) : null));

/**
 * The exact geometry of a run being reused, when there is one.
 *
 * Aspect and megapixels do not determine a size on their own -- they are rounded
 * to what the model accepts -- so restoring only those would reproduce a run
 * approximately. This holds the frame the earlier run actually used, and any
 * touch of a size control drops it and hands the arithmetic back to the panel.
 */
const exact = ref<{ width: number; height: number; numFrames: number } | null>(null);

watch([aspect, megapixels, seconds, fps], () => (exact.value = null), { flush: 'sync' });

const frame = computed<Frame>(() => {
  const fixed = exact.value;
  if (!fixed) return resolveFrame(aspect.value as Aspect, megapixels.value);
  return {
    width: fixed.width,
    height: fixed.height,
    megapixels: (fixed.width * fixed.height) / 1_000_000,
    ratio: fixed.width / fixed.height,
  };
});

const duration = computed<Duration>(() => {
  const fixed = exact.value;
  if (!fixed) return resolveDuration(seconds.value, fps.value);
  return { numFrames: fixed.numFrames, seconds: fixed.numFrames / Math.max(1, fps.value) };
});

const output = computed(() =>
  resolveOutput(frame.value, duration.value, fps.value, spatialUpsample.value, temporalUpsample.value),
);
const tokens = computed(() => latentTokens(frame.value.width, frame.value.height, duration.value.numFrames));

const aspectOptions = ASPECTS.map((option) => ({ value: option, label: option }));

/** Puts a previous run back into the form, exactly as it was asked for. */
function restoreFrom(meta: MediaMeta): void {
  const settings = meta.settings;
  prompt.value = meta.prompt ?? '';
  referenceId.value = meta.referenceId ?? null;
  const previousOffload = meta.armParams?.['offload'];
  if (typeof previousOffload === 'string') offload.value = previousOffload;
  if (!settings) return;

  if (settings.aspect && (ASPECTS as readonly string[]).includes(settings.aspect)) {
    aspect.value = settings.aspect;
  }
  if (settings.megapixels) megapixels.value = settings.megapixels;
  if (settings.seconds) seconds.value = settings.seconds;
  fps.value = settings.frameRate;
  seed.value = `${settings.seed}`;
  enhancePrompt.value = settings.enhancePrompt;
  spatialUpsample.value = settings.spatialUpsample;
  temporalUpsample.value = settings.temporalUpsample;
  // Last, because the assignments above each clear it.
  exact.value = { width: settings.width, height: settings.height, numFrames: settings.numFrames };
}

watch(
  () => props.restore,
  (meta) => {
    if (meta) restoreFrom(meta);
  },
  { immediate: true },
);

watch(
  () => props.initialReference,
  (id) => {
    if (id) referenceId.value = id;
  },
  { immediate: true },
);

const status = ref<'idle' | 'generating'>('idle');
const failure = ref<string | null>(null);
const result = ref<{ media: MediaItem; report: ArmGenerationReport } | null>(null);

const { job, machine, armVram, capacityGib, available, elapsedSeconds, watch: follow, stopWatching } =
  useJobTelemetry();

const canGenerate = computed(() => prompt.value.trim().length > 0 && status.value === 'idle');

async function generate(): Promise<void> {
  if (!canGenerate.value || !arm.value) return;

  status.value = 'generating';
  failure.value = null;
  result.value = null;

  const typed = seed.value.trim();
  const chosen = typed === '' ? -1 : Number(typed);

  const settings: JobSettings = {
    aspect: aspect.value,
    megapixels: megapixels.value,
    seconds: seconds.value,
    width: frame.value.width,
    height: frame.value.height,
    numFrames: duration.value.numFrames,
    frameRate: fps.value,
    seed: Number.isFinite(chosen) ? chosen : -1,
    enhancePrompt: enhancePrompt.value,
    spatialUpsample: spatialUpsample.value,
    temporalUpsample: temporalUpsample.value,
  };

  // Chosen here rather than returned by the server: the run takes minutes, and
  // the console has to be able to ask about it while the request is still open.
  const jobId = crypto.randomUUID();
  const body: GenerateRequest = {
    jobId,
    prompt: prompt.value.trim(),
    settings,
    output: output.value,
    ...(referenceId.value ? { referenceId: referenceId.value } : {}),
    ...(offload.value ? { armParams: { offload: offload.value } } : {}),
  };

  follow(jobId);

  try {
    result.value = await $fetch<GenerateResponse>(
      `/api/arms/${encodeURIComponent(arm.value.id)}/generate`,
      { method: 'POST', body },
    );
    await refreshMedia();
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    status.value = 'idle';
  }
}

const number = (value: number): string => value.toLocaleString('en-US');
</script>

<template>
  <div class="flex h-full">
    <aside class="w-80 shrink-0 space-y-5 overflow-y-auto border-r border-white/10 p-5">
      <UiField
        label="Arm"
        for="arm"
        hint="text-to-video, image-to-video, eight distilled steps, video and audio together"
      >
        <UiSelect id="arm" v-model="armId" :options="armOptions" />
      </UiField>

      <UiCheckbox
        v-model="enhancePrompt"
        label="Prompt enhancer"
        hint="The repository's own Gemma, 9.51 GiB, loaded for the jobs that ask and freed again."
      />

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-slate-200">Frame</legend>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Aspect" for="aspect">
            <UiSelect id="aspect" v-model="aspect" :options="aspectOptions" />
          </UiField>
          <UiField label="Megapixels" for="megapixels">
            <UiNumberInput id="megapixels" v-model="megapixels" :min="0.05" :max="4" :step="0.05" />
          </UiField>
        </div>
        <p class="text-xs text-slate-500">
          <span class="text-slate-300">{{ frame.width }}&#215;{{ frame.height }}</span>
          &middot; {{ frame.megapixels.toFixed(2) }} MP &middot; actual ratio {{ frame.ratio.toFixed(2) }}
        </p>
        <p v-if="exact" class="text-xs text-indigo-300/80">
          Exact frame from the run being reused. Changing any size control returns to the aspect and
          megapixel arithmetic.
        </p>
      </fieldset>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-slate-200">Duration</legend>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Seconds" for="seconds">
            <UiNumberInput id="seconds" v-model="seconds" :min="0.5" :max="20" :step="0.5" />
          </UiField>
          <UiField label="FPS" for="fps">
            <UiNumberInput id="fps" v-model="fps" :min="8" :max="60" />
          </UiField>
        </div>
        <p class="text-xs text-slate-500">
          <span class="text-slate-300">{{ duration.numFrames }}</span> frames &middot;
          {{ duration.seconds.toFixed(2) }} s actual
        </p>
      </fieldset>

      <UiField label="Seed" for="seed" hint="Empty picks one at random and the library records which.">
        <UiInput id="seed" v-model="seed" placeholder="empty = random" />
      </UiField>

      <UiField v-if="offloadOptions.length > 0" label="Offload" for="offload">
        <UiSelect id="offload" v-model="offload" :options="offloadOptions" />
        <template #hint>
          How weights reach the card. Changing it reloads the arm, because placement is decided when the
          weights are read.
        </template>
      </UiField>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-slate-200">Upsamplers</legend>
        <UiCheckbox v-model="spatialUpsample" label="Spatial (&#215;2 edge)" />
        <UiCheckbox v-model="temporalUpsample" label="Temporal (&#215;2 frames, same duration)" />
        <p class="text-xs text-slate-500">
          Lightricks' own latent upsamplers. Each runs a further denoising round on what it upsampled, so
          the model redraws detail rather than interpolating it.
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

    <div class="grid min-w-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_30rem]">
      <main class="min-w-0 space-y-6 p-6">
        <UiField label="Prompt" for="prompt" required>
          <UiTextarea
            id="prompt"
            v-model="prompt"
            :rows="5"
            placeholder="Describe the scene, the motion, the light"
          />
          <template #hint>
            The model was trained on long single-paragraph audio-visual captions and degrades on short
            prompts. The enhancer rewrites a short one into that style.
          </template>
        </UiField>

        <UiField label="Reference image">
          <div class="flex items-start gap-3">
            <button
              type="button"
              class="h-24 w-32 shrink-0 overflow-hidden rounded-lg border border-dashed border-white/20 text-xs text-slate-500 transition-colors hover:border-white/40 hover:text-slate-300"
              data-testid="open-picker"
              @click="picking = true"
            >
              <MediaThumb v-if="reference" :item="reference" fit="contain" />
              <span v-else>Choose or upload</span>
            </button>
            <div class="min-w-0 space-y-1">
              <p v-if="reference" class="truncate text-sm text-slate-200">{{ reference.name }}</p>
              <p v-if="reference" class="text-xs text-slate-500">{{ formatBytes(reference.bytes) }}</p>
              <UiBadge v-if="reference" tone="accent">image-to-video</UiBadge>
              <div class="flex gap-2 pt-1">
                <UiButton size="sm" @click="picking = true">
                  {{ reference ? 'Change' : 'Select media' }}
                </UiButton>
                <UiButton v-if="reference" size="sm" variant="ghost" @click="referenceId = null">
                  Remove
                </UiButton>
              </div>
            </div>
          </div>
          <template #hint>
            A reference switches the run to image-to-video: the still becomes the first frame and the clip
            moves on from it.
          </template>
        </UiField>

        <div class="flex flex-wrap items-center gap-3">
          <UiButton variant="primary" :disabled="!canGenerate" data-testid="generate" @click="generate">
            {{ status === 'generating' ? 'Running…' : 'Generate' }}
          </UiButton>
          <UiButton v-if="job && status === 'generating'" @click="stopWatching()">Stop watching</UiButton>
          <NuxtLink to="/library" class="ml-auto">
            <UiButton>Library →</UiButton>
          </NuxtLink>
        </div>

        <p class="text-xs text-slate-500">
          No arm has to be started first. The supervisor stops whatever holds the card and loads what this
          job needs.
        </p>

        <UiAlert v-if="failure" tone="error">{{ failure }}</UiAlert>

        <section v-if="result" class="space-y-3">
          <video
            :key="result.media.id"
            :src="mediaUrl(result.media.id)"
            class="w-full rounded-lg border border-white/10"
            controls
            autoplay
            loop
          />
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span class="text-slate-200">{{ result.media.name }}</span>
            <span>{{ result.report.seconds_total.toFixed(1) }} s</span>
            <span>{{ formatBytes(result.media.bytes) }}</span>
            <span>seed {{ result.report.seed }}</span>
            <span>peak {{ result.report.peak_vram_reserved_gib.toFixed(2) }} GiB</span>
            <NuxtLink
              :to="{ path: '/library', query: { folder: result.media.group, item: result.media.id } }"
              class="text-indigo-300 hover:text-indigo-200"
            >
              Open in library →
            </NuxtLink>
          </div>
        </section>
      </main>

      <aside class="min-w-0 space-y-5 border-white/10 p-6 xl:border-l">
        <VramChart
          :machine="machine"
          :arm="armVram"
          :capacity-gib="capacityGib"
          :available="available"
        />

        <JobTimeline :job="job" :elapsed-seconds="elapsedSeconds" />

        <p v-if="!job" class="text-sm text-slate-500">
          The chart runs whether or not this studio does — what the card already holds is most of the gap
          between the two meters. A job's own steps appear here once one is submitted.
        </p>
      </aside>
    </div>

    <MediaPicker
      :open="picking"
      kind="image"
      :selected-id="referenceId"
      @close="picking = false"
      @select="(id) => (referenceId = id)"
    />
  </div>
</template>
