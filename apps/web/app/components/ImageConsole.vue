<script setup lang="ts">
/**
 * The image console: settings, the work, and what the machine is doing with it.
 *
 * The same three columns as the video console, for the same reasons, and the
 * same rule about arms: a job names the arm and the configuration it needs, the
 * supervisor brokers the card into that state, and nobody presses Start.
 *
 * What is different is the batch. One request here produces several files, each
 * with its own seed and its own library record, so the result is a grid rather
 * than a single player and "use these settings" on any one of them reproduces
 * that one image rather than the batch it came in.
 */
import { computed, ref, watch } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { ArmImageReport, ImageGenerateRequest, ImageGenerateResponse } from '#shared/generate';
import { ratioLabel } from '#shared/image-size';
import {
  formatBytes,
  isImageSettings,
  type ImageJobSettings,
  type MediaItem,
  type MediaMeta,
} from '#shared/library';

import {
  ASPECTS,
  aspectRatio,
  IMAGE_MULTIPLE,
  MAX_EDGE,
  MIN_EDGE,
  REFERENCE_ASPECT,
  type Aspect,
} from '../utils/frame';
import JobTimeline from './JobTimeline.vue';
import MediaLightbox from './MediaLightbox.vue';
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
  /** An image to edit, from `?reference=` on the page. */
  initialReference?: string | null;
}>();

/** Qwen-Image-Edit composes its references rather than choosing between them. */
const MAX_REFERENCES = 4;
/** `limits.max_batch_count` from the child's capabilities, not a guess. */
const MAX_BATCH = 8;
const BATCH_PRESETS = [1, 2, 4, MAX_BATCH];

/**
 * Why a peak might not be this arm's own.
 *
 * A GeForce card under Windows runs in WDDM mode, where the display driver owns
 * the allocations and nvidia-smi answers `[N/A]` for every process. The arm
 * then measures the whole card and says so rather than reporting a figure that
 * looks like its own share.
 */
const VRAM_SCOPE: Record<string, string> = {
  process: "this arm's child process",
  card: 'the whole card — this driver will not attribute memory per process',
  unavailable: 'nothing — nvidia-smi did not answer',
};

/**
 * Samplers and schedulers the arm passes straight through to the child.
 *
 * Spelled exactly as `sd-server -h` spells them, and a curated subset rather
 * than all twenty-one: the arm validates the *shape* of a name, so a build that
 * adds one needs no change there, but a console offering every sampler it can
 * compile is not a kindness.
 *
 * The empty value means "say nothing", which is not the same as picking one:
 * upstream documents the sampler as model-specific and the scheduler as a
 * model default, and a console that always sent a value would be overriding a
 * choice the checkpoint shipped with.
 */
const SAMPLERS = [
  { value: 'euler', label: 'euler — what upstream uses for Qwen edit' },
  { value: '', label: 'auto — the model’s own' },
  { value: 'euler_a', label: 'euler_a — ancestral' },
  { value: 'dpm++2m', label: 'dpm++2m' },
  { value: 'dpm++2s_a', label: 'dpm++2s_a' },
  { value: 'heun', label: 'heun' },
  { value: 'ipndm', label: 'ipndm' },
  { value: 'res_multistep', label: 'res_multistep' },
  { value: 'lcm', label: 'lcm — for distilled checkpoints' },
];

const SCHEDULERS = [
  { value: '', label: 'auto — the model’s own' },
  { value: 'discrete', label: 'discrete (alias: normal)' },
  { value: 'beta', label: 'beta' },
  { value: 'karras', label: 'karras' },
  { value: 'exponential', label: 'exponential' },
  { value: 'sgm_uniform', label: 'sgm_uniform' },
  { value: 'simple', label: 'simple' },
  { value: 'smoothstep', label: 'smoothstep' },
  { value: 'kl_optimal', label: 'kl_optimal' },
  { value: 'bong_tangent', label: 'bong_tangent' },
];

// By capability, not modality. Two image arms can be unable to run each
// other's jobs, and this console once offered a scaffold that had only a
// health endpoint -- an entry whose every job would have failed.
const imageArms = computed(() =>
  props.arms.filter((arm) => arm.capabilities.includes('image.generate')),
);
const armId = ref<string>('');

watch(
  imageArms,
  (list) => {
    if (!armId.value && list[0]) armId.value = list[0].id;
  },
  { immediate: true },
);

const armOptions = computed(() => imageArms.value.map((arm) => ({ value: arm.id, label: arm.name })));
const arm = computed(() => imageArms.value.find((candidate) => candidate.id === armId.value) ?? null);

interface SchemaProperty {
  default?: unknown;
  description?: string;
  enum?: string[];
}

function schemaProperty(key: string): SchemaProperty | null {
  const properties = (arm.value?.paramsSchema as { properties?: Record<string, SchemaProperty> } | null)
    ?.properties;
  return properties?.[key] ?? null;
}

/** The checkpoint file this arm loads, as its own parameter schema names it. */
const modelName = computed(() => {
  const value = schemaProperty('diffusionModel')?.default;
  return typeof value === 'string' ? (value.split('/').pop() ?? value) : null;
});

/**
 * Three different things, told apart: nothing to pick, something picked whose
 * model is known, and something picked that names no default model. Reading
 * the last as the first is how this line once claimed no arm existed while an
 * arm was selected in the control above it.
 */
const armHint = computed(() => {
  if (!arm.value) {
    return 'No arm declares image.generate. Check capabilities in a manifest under arms/.';
  }
  return modelName.value ?? 'This arm declares no default diffusion model.';
});

// Start parameters: changing either restarts the arm, because both decide how
// the weights are placed. The console says so rather than hiding it.
const offloadToCpu = ref(true);
const flashAttention = ref(true);

const prompt = ref('');
const negativePrompt = ref('');
const aspect = ref<string>('1:1');
const width = ref(1024);
const height = ref(1024);
// The distilled "rapid" merge that ships with this arm: four steps, unguided.
// The stock Qwen-Image-Edit 2511 wants 20 steps at CFG 2.5 instead, which is
// what the hint under Steps says.
const steps = ref(4);
const cfgScale = ref(1);
const sampler = ref('euler_a');
const scheduler = ref('beta');
const flowShift = ref(3);
const seed = ref('');
const batch = ref(1);

const referenceIds = ref<(string | null)[]>([null]);
/** Which reference slot the picker is filling, or null when it is closed. */
const picking = ref<number | null>(null);

const { byId, refresh: refreshMedia } = useMedia();

const references = computed(() =>
  referenceIds.value
    .map((id) => (id ? (byId.value.get(id) ?? null) : null))
    .filter((item): item is MediaItem => item !== null),
);

const chosenIds = computed(() => referenceIds.value.filter((id): id is string => id !== null));

/** The first reference's own ratio, when its header was read. */
const referenceRatio = computed(() => {
  const first = references.value[0];
  if (!first?.width || !first.height) return null;
  return { ratio: first.width / first.height, label: ratioLabel(first.width, first.height) };
});

const aspectOptions = computed(() => [
  ...(referenceRatio.value
    ? [{ value: REFERENCE_ASPECT, label: `match reference — ${referenceRatio.value.label}` }]
    : []),
  ...ASPECTS.map((option) => ({ value: option, label: option })),
]);

/** The shape being asked for: a named aspect, or the first reference's own. */
const ratio = computed(() =>
  aspect.value === REFERENCE_ASPECT
    ? (referenceRatio.value?.ratio ?? 1)
    : aspectRatio(aspect.value as Aspect),
);

const snap = (value: number): number =>
  Math.max(MIN_EDGE, Math.min(MAX_EDGE, Math.round(value / IMAGE_MULTIPLE) * IMAGE_MULTIPLE));

/**
 * The two edges drive each other through the aspect.
 *
 * Which one is authoritative is whichever one was last typed into, so the pair
 * never argues with the person editing it. Both commit on blur rather than per
 * keystroke -- see `lazy` on the input -- because `1024` passes through 1 and
 * 10 on the way, and each of those would drag the other edge somewhere absurd.
 */
const widthModel = computed({
  get: () => width.value,
  set: (value) => {
    width.value = snap(value);
    height.value = snap(width.value / ratio.value);
  },
});

const heightModel = computed({
  get: () => height.value,
  set: (value) => {
    height.value = snap(value);
    width.value = snap(height.value * ratio.value);
  },
});

/**
 * A new aspect moves the height and leaves the width alone.
 *
 * Width is the edge people hold fixed -- it is the one a model's training
 * resolution is usually quoted in -- so the aspect reshapes around it rather
 * than rescaling both.
 *
 * Synchronous, because restoring a previous run sets the aspect and then the
 * exact size that run used: a deferred watch would land second and overwrite
 * the real numbers with derived ones.
 */
watch(
  [aspect, referenceRatio],
  () => {
    height.value = snap(width.value / ratio.value);
  },
  { immediate: true, flush: 'sync' },
);

watch(referenceRatio, (current) => {
  // Chose "match reference" and then removed it: the panel must not go on
  // claiming a ratio it no longer has.
  if (!current && aspect.value === REFERENCE_ASPECT) aspect.value = '1:1';
});

/** Both edges are already on the grid; this is what the arm will be sent. */
const snapped = computed(() => ({ width: width.value, height: height.value }));

const megapixelsOut = computed(() => (width.value * height.value) / 1_000_000);
const actualRatio = computed(() => width.value / height.value);

function choose(id: string | null): void {
  const slot = picking.value;
  if (slot === null) return;

  const next = [...referenceIds.value];
  next[slot] = id;
  // Keep the slots dense: a hole in the middle would send a reference list the
  // arm reads positionally, with the wrong image in the wrong place.
  referenceIds.value = next.filter((entry) => entry !== null);
  if (referenceIds.value.length < MAX_REFERENCES) referenceIds.value.push(null);

  // The first reference decides the shape, the way it does in the video
  // console -- an edit of an image that is not that image's shape is an edit
  // the model has to letterbox before it can start.
  if (slot === 0 && id && byId.value.get(id)?.width) aspect.value = REFERENCE_ASPECT;
}

function removeReference(index: number): void {
  const next = referenceIds.value.filter((_, position) => position !== index);
  referenceIds.value = next.length > 0 ? next : [null];
  if (referenceIds.value.at(-1) !== null && referenceIds.value.length < MAX_REFERENCES) {
    referenceIds.value.push(null);
  }
}

/** Puts a previous run back into the form, exactly as it was asked for. */
function restoreFrom(meta: MediaMeta): void {
  prompt.value = meta.prompt ?? '';
  negativePrompt.value = meta.negativePrompt ?? '';

  const ids = meta.referenceIds ?? (meta.referenceId ? [meta.referenceId] : []);
  referenceIds.value = ids.length < MAX_REFERENCES ? [...ids, null] : [...ids];

  const offload = meta.armParams?.['offloadToCpu'];
  if (typeof offload === 'string') offloadToCpu.value = offload === 'true';
  const attention = meta.armParams?.['flashAttention'];
  if (typeof attention === 'string') flashAttention.value = attention === 'true';

  const settings = meta.settings;
  if (!isImageSettings(settings)) return;

  const known = [REFERENCE_ASPECT, ...ASPECTS] as readonly string[];
  if (settings.aspect && known.includes(settings.aspect)) aspect.value = settings.aspect;
  steps.value = settings.steps;
  cfgScale.value = settings.cfgScale;
  sampler.value = settings.sampler;
  scheduler.value = settings.scheduler;
  flowShift.value = settings.flowShift;
  seed.value = `${settings.seed}`;
  batch.value = settings.batch;
  // Last: the assignments above each re-derive the size synchronously, and
  // this is the size the run actually used.
  width.value = settings.width;
  height.value = settings.height;
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
    if (!id) return;
    referenceIds.value = [id, null];
    if (byId.value.get(id)?.width) aspect.value = REFERENCE_ASPECT;
  },
  { immediate: true },
);

const status = ref<'idle' | 'generating'>('idle');
const failure = ref<string | null>(null);
const results = ref<MediaItem[]>([]);
const report = ref<ArmImageReport | null>(null);
const preview = ref<MediaItem | null>(null);

const { job, machine, armVram, capacityGib, available, elapsedSeconds, watch: follow, stopWatching } =
  useJobTelemetry();

const canGenerate = computed(
  () => prompt.value.trim().length > 0 && status.value === 'idle' && arm.value !== null,
);

async function generate(): Promise<void> {
  if (!canGenerate.value || !arm.value) return;

  status.value = 'generating';
  failure.value = null;
  results.value = [];
  report.value = null;

  const typed = seed.value.trim();
  const chosen = typed === '' ? -1 : Number(typed);

  const settings: ImageJobSettings = {
    kind: 'image',
    aspect: aspect.value,
    width: snapped.value.width,
    height: snapped.value.height,
    steps: steps.value,
    cfgScale: cfgScale.value,
    sampler: sampler.value,
    scheduler: scheduler.value,
    flowShift: flowShift.value,
    seed: Number.isFinite(chosen) ? chosen : -1,
    batch: batch.value,
    // Overwritten per file by the server, which knows which one each is.
    batchIndex: 0,
  };

  // Chosen here rather than returned by the server: the console has to be able
  // to ask about the job while the request that submitted it is still open.
  const jobId = crypto.randomUUID();
  const body: ImageGenerateRequest = {
    jobId,
    prompt: prompt.value.trim(),
    settings,
    output: { width: snapped.value.width, height: snapped.value.height, count: batch.value },
    ...(negativePrompt.value.trim() ? { negativePrompt: negativePrompt.value.trim() } : {}),
    ...(chosenIds.value.length > 0 ? { referenceIds: chosenIds.value } : {}),
    armParams: {
      offloadToCpu: offloadToCpu.value ? 'true' : 'false',
      flashAttention: flashAttention.value ? 'true' : 'false',
    },
  };

  follow(jobId);

  try {
    const answer = await $fetch<ImageGenerateResponse>(
      `/api/arms/${encodeURIComponent(arm.value.id)}/image`,
      { method: 'POST', body },
    );
    results.value = answer.media;
    report.value = answer.report;
    await refreshMedia();
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    status.value = 'idle';
  }
}
</script>

<template>
  <div class="flex h-full">
    <aside class="w-80 shrink-0 space-y-5 overflow-y-auto border-r border-white/10 p-5">
      <UiField label="Arm" for="arm">
        <UiSelect id="arm" v-model="armId" :options="armOptions" />
        <template #hint>
          <span>{{ armHint }}</span>
        </template>
      </UiField>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-slate-200">Frame</legend>
        <UiField label="Aspect" for="aspect">
          <UiSelect id="aspect" v-model="aspect" :options="aspectOptions" />
        </UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Width" for="width">
            <UiNumberInput
              id="width"
              v-model="widthModel"
              lazy
              :min="MIN_EDGE"
              :max="MAX_EDGE"
              :step="IMAGE_MULTIPLE"
            />
          </UiField>
          <UiField label="Height" for="height">
            <UiNumberInput
              id="height"
              v-model="heightModel"
              lazy
              :min="MIN_EDGE"
              :max="MAX_EDGE"
              :step="IMAGE_MULTIPLE"
            />
          </UiField>
        </div>
        <p class="text-xs text-slate-500">
          {{ megapixelsOut.toFixed(2) }} MP &middot; actual ratio {{ actualRatio.toFixed(3) }}
        </p>
        <p class="text-xs text-slate-500">
          Either edge sets the other through the aspect; changing the aspect moves the height. Both land on
          a multiple of {{ IMAGE_MULTIPLE }}, which is the model's own grid.
        </p>
        <p v-if="aspect === REFERENCE_ASPECT && references[0]" class="text-xs text-slate-500">
          Shaped to {{ references[0].name }} ({{ references[0].width }}&#215;{{ references[0].height }}).
        </p>
      </fieldset>

      <div class="grid grid-cols-2 gap-3">
        <UiField label="Steps" for="steps">
          <UiNumberInput id="steps" v-model="steps" :min="1" :max="100" />
        </UiField>
        <UiField label="CFG scale" for="cfg">
          <UiNumberInput id="cfg" v-model="cfgScale" :min="0" :max="30" :step="0.1" />
        </UiField>
      </div>
      <p class="-mt-3 text-xs text-slate-500">
        Four steps at CFG 1 is the distilled Rapid merge: it is trained to finish in that many and is
        unguided, so the negative prompt does nothing. Stock Qwen-Image-Edit 2511 wants 20 steps at CFG 2.5.
      </p>

      <div class="grid grid-cols-2 gap-3">
        <UiField label="Sampler" for="sampler">
          <UiSelect id="sampler" v-model="sampler" :options="SAMPLERS" />
        </UiField>
        <UiField label="Scheduler" for="scheduler">
          <UiSelect id="scheduler" v-model="scheduler" :options="SCHEDULERS" />
        </UiField>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <UiField label="Flow shift" for="flow">
          <UiNumberInput id="flow" v-model="flowShift" :min="0" :max="10" :step="0.1" />
        </UiField>
        <UiField label="Seed" for="seed">
          <UiInput id="seed" v-model="seed" placeholder="empty = random" />
        </UiField>
      </div>
      <p class="-mt-3 text-xs text-slate-500">
        A batch increments the seed per image, and the library records the one each file actually used.
      </p>

      <fieldset class="space-y-2 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">How the weights are placed</legend>
        <UiCheckbox
          v-model="offloadToCpu"
          label="Offload to CPU"
          hint="Keeps weights in host RAM and moves them across as they are needed. On a 16 GiB card this is what makes the transformer and the text encoder fit together at all."
        />
        <UiCheckbox
          v-model="flashAttention"
          label="Flash attention"
          hint="Cuts the attention activation peak. Upstream's own Qwen-Image-Edit examples all enable it."
        />
        <p class="text-xs text-slate-500">
          Both are start parameters: changing either restarts the arm, because placement is decided when the
          weights are read.
        </p>
      </fieldset>
    </aside>

    <div class="grid min-w-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_30rem]">
      <main class="min-w-0 space-y-6 p-6">
        <UiField label="Reference images">
          <div class="flex flex-wrap items-start gap-3">
            <div v-for="(id, index) in referenceIds" :key="`${index}-${id ?? 'empty'}`" class="space-y-1">
              <button
                type="button"
                class="h-28 w-28 overflow-hidden rounded-lg border border-dashed border-white/20 text-xs text-slate-500 transition-colors hover:border-white/40 hover:text-slate-300"
                :data-testid="`reference-${index}`"
                @click="picking = index"
              >
                <MediaThumb
                  v-if="id && byId.get(id)"
                  :item="byId.get(id) as MediaItem"
                  fit="contain"
                />
                <span v-else>+ Add</span>
              </button>
              <button
                v-if="id"
                type="button"
                class="block w-28 text-center text-[10px] text-slate-500 hover:text-rose-300"
                @click="removeReference(index)"
              >
                remove
              </button>
            </div>
          </div>
          <template #hint>
            Up to {{ MAX_REFERENCES }}. Qwen-Image-Edit composes them into one scene rather than treating
            them as alternatives, and the first one decides the frame's shape. With none, this is plain
            text-to-image.
          </template>
        </UiField>

        <UiField label="Prompt" for="prompt" required>
          <UiTextarea
            id="prompt"
            v-model="prompt"
            :rows="4"
            placeholder="Describe the edit, or the image to make"
          />
          <template #hint>
            An edit model reads instructions: say what should change and what should stay.
          </template>
        </UiField>

        <UiField label="Batch">
          <div class="flex flex-wrap items-center gap-2">
            <UiButton
              v-for="preset in BATCH_PRESETS"
              :key="preset"
              size="sm"
              :active="batch === preset"
              :data-testid="`batch-${preset}`"
              @click="batch = preset"
            >
              {{ preset }}
            </UiButton>
            <div class="w-24"><UiNumberInput v-model="batch" :min="1" :max="MAX_BATCH" /></div>
          </div>
          <template #hint>
            One load, {{ batch }} image{{ batch === 1 ? '' : 's' }}, each filed separately with its own seed.
          </template>
        </UiField>

        <UiField label="Negative prompt" for="negative">
          <UiTextarea
            id="negative"
            v-model="negativePrompt"
            :rows="2"
            placeholder="What to keep out of the image"
          />
          <template #hint>
            Only does something above CFG 1.0 — at 1.0 the model is unguided and there is nothing to steer
            away from, which is the case on a distilled “rapid” merge.
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

        <section v-if="results.length" class="space-y-3">
          <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <li v-for="item in results" :key="item.id">
              <button
                type="button"
                class="w-full overflow-hidden rounded-lg border border-white/10 text-left hover:border-white/30"
                @click="preview = item"
              >
                <div class="aspect-square"><MediaThumb :item="item" fit="contain" /></div>
                <div class="space-y-0.5 p-2">
                  <p class="truncate text-xs text-slate-200">{{ item.name }}</p>
                  <p class="font-mono text-[10px] text-slate-500">
                    seed {{ item.meta?.settings?.seed }}
                  </p>
                </div>
              </button>
            </li>
          </ul>
          <div v-if="report" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{{ report.seconds_total.toFixed(1) }} s</span>
            <span>{{ report.images.length }} file{{ report.images.length === 1 ? '' : 's' }}</span>
            <span>{{ formatBytes(report.images.reduce((sum, one) => sum + one.out_bytes, 0)) }}</span>
            <span>{{ report.steps }} step</span>
            <span :title="VRAM_SCOPE[report.vram_scope]">
              peak {{ report.peak_vram_gib.toFixed(2) }} GiB
              <span v-if="report.vram_scope !== 'process'" class="text-slate-500">
                ({{ report.vram_scope === 'card' ? 'whole card' : 'unmeasured' }})
              </span>
            </span>
            <NuxtLink
              v-if="results[0]"
              :to="{ path: '/library', query: { folder: results[0].group, item: results[0].id } }"
              class="text-indigo-300 hover:text-indigo-200"
            >
              Open in library →
            </NuxtLink>
          </div>
        </section>
      </main>

      <aside class="min-w-0 space-y-5 border-white/10 p-6 xl:border-l">
        <VramChart :machine="machine" :arm="armVram" :capacity-gib="capacityGib" :available="available" />

        <JobTimeline :job="job" :elapsed-seconds="elapsedSeconds" />

        <div v-if="!job" class="space-y-2 text-sm text-slate-500">
          <p>
            The chart runs whether or not this studio does — what the card already holds is most of the gap
            between the two meters. A job's own steps appear here once one is submitted.
          </p>
          <p class="text-xs">
            There is no torch in this arm to ask — the weights live in a child process written in C++ — so
            its meter is nvidia-smi's. On a GeForce card under Windows that means a whole-card figure, and
            the two lines will sit on top of each other: the driver will not attribute memory per process.
          </p>
        </div>
      </aside>
    </div>

    <MediaPicker
      :open="picking !== null"
      kind="image"
      :selected-id="picking === null ? null : referenceIds[picking]"
      @close="picking = null"
      @select="choose"
    />

    <MediaLightbox
      :item="preview"
      :items="results"
      @close="preview = null"
      @navigate="(item) => (preview = item)"
    />
  </div>
</template>
