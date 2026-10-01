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
import { mergePrompt } from '#shared/generate';
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
  SPATIAL_MULTIPLE,
  type Aspect,
} from '../utils/frame';
import { restoreKey } from '../utils/restore';
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

/**
 * Qwen-Image-Edit composes its references rather than choosing between them.
 *
 * Three, not four: ComfyUI's `TextEncodeQwenImageEditPlus` takes image1
 * through image3 and has nowhere to put a fourth.
 */
const MAX_REFERENCES = 3;
/**
 * One ComfyUI prompt per image, so a batch costs no extra VRAM.
 *
 * The ceiling is about time: the request stays open until the last file is
 * written, and this arm holds the card for all of it. It is a guard against a
 * mistyped number, not a limit of the machine.
 */
const MAX_BATCH = 100;
const BATCH_PRESETS = [1, 2, 4, 8, 16];

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
 * Samplers and schedulers the arm passes straight through to ComfyUI.
 *
 * Spelled exactly as `comfy/samplers.py` spells them, and a curated subset
 * rather than all forty: the arm validates the *shape* of a name, so a ComfyUI
 * that adds one needs no change there, but a console offering every sampler
 * that exists is not a kindness.
 *
 * There is no "auto" here, unlike the sd.cpp console this replaced: ComfyUI's
 * `KSampler` has no such value, so the first entry is what ComfyUI's own Qwen
 * 2511 blueprint ships with.
 */
const SAMPLERS = [
  { value: 'euler', label: 'euler — what ComfyUI’s Qwen 2511 blueprint uses' },
  { value: 'euler_ancestral', label: 'euler_ancestral' },
  { value: 'dpmpp_2m', label: 'dpmpp_2m' },
  { value: 'dpmpp_2m_sde', label: 'dpmpp_2m_sde' },
  { value: 'dpmpp_3m_sde', label: 'dpmpp_3m_sde' },
  { value: 'dpmpp_sde', label: 'dpmpp_sde' },
  { value: 'heun', label: 'heun' },
  { value: 'ddpm', label: 'ddpm' },
  { value: 'ipndm', label: 'ipndm' },
  { value: 'res_multistep', label: 'res_multistep' },
  { value: 'gradient_estimation', label: 'gradient_estimation' },
  { value: 'er_sde', label: 'er_sde' },
  { value: 'lcm', label: 'lcm — for distilled checkpoints' },
];

const SCHEDULERS = [
  { value: 'simple', label: 'simple — the blueprint’s' },
  { value: 'beta', label: 'beta' },
  { value: 'normal', label: 'normal' },
  { value: 'karras', label: 'karras' },
  { value: 'exponential', label: 'exponential' },
  { value: 'sgm_uniform', label: 'sgm_uniform' },
  { value: 'ddim_uniform', label: 'ddim_uniform' },
  { value: 'linear_quadratic', label: 'linear_quadratic' },
  { value: 'kl_optimal', label: 'kl_optimal' },
];

/**
 * How the transformer is held on the card.
 *
 * A start parameter: the cast happens as the weights are read, so changing it
 * is a different child process. The bf16 checkpoint is nineteen gigabytes
 * against a sixteen gigabyte card, which is why fp8 is the default rather than
 * the exception.
 */
const WEIGHT_DTYPES = [
  { value: 'fp8_e4m3fn', label: 'fp8_e4m3fn — halves the transformer, fits the card' },
  { value: 'fp8_e4m3fn_fast', label: 'fp8_e4m3fn_fast — also uses the card’s fp8 matmul' },
  { value: 'fp8_e5m2', label: 'fp8_e5m2 — more range, less precision' },
  { value: 'default', label: 'default — the checkpoint’s own dtype, streamed if it will not fit' },
];

const VRAM_MODES = [
  { value: 'dynamic', label: 'dynamic — ComfyUI decides what to stream' },
  { value: 'highvram', label: 'highvram — keep everything resident' },
  { value: 'lowvram', label: 'lowvram — split the model aggressively' },
  { value: 'novram', label: 'novram — when lowvram is not enough' },
];

/**
 * Styles worth keeping, as the pair of prompts that produce them.
 *
 * Only the look: no subject, no pose, no framing. A preset that described a
 * character would fight whatever is typed in the box below it, and the whole
 * point of the split is that the style survives a change of subject.
 */
const STYLE_PRESETS: { name: string; style: string; negative: string }[] = [
  {
    name: '3D xianxia',
    style: [
      'semi-realistic 3D rendered xianxia illustration',
      'cinematic character render, Chinese fantasy wuxia aesthetic',
      'stylised anime proportions with physically based skin shading and subsurface scattering',
      'strand-level hair detail with soft backlit rim light',
      'porcelain pale complexion, delicate features',
      'desaturated palette of ash grey and charcoal with deep crimson accents',
      'low-key volumetric lighting, cool overcast key light, warm rim light',
      'shallow depth of field, creamy bokeh',
      'drifting snow and dust motes in the air',
      'fine film grain, subtle chromatic aberration',
      'detailed silk, embroidery and blackened metal materials',
      'Unreal Engine 5 and Octane cinematic render, 8k, highly detailed',
    ].join(', '),
    negative: [
      'photograph, real person, photorealistic skin pores',
      'flat 2D cel shading, lineart, manga screentone, sketch, oil painting texture',
      'western cartoon, chibi, low detail',
      'blurry, out of focus, jpeg artifacts, lowres',
      'oversaturated, neon colours, flat frontal lighting, blown highlights',
      'plastic skin, waxy skin, doll-like, dead eyes, asymmetric eyes',
      'bad anatomy, bad proportions, deformed hands, extra fingers, fused fingers, extra limbs',
      'mutated, disfigured',
      'watermark, signature, text, logo, username, border, frame, cropped',
      'modern clothing',
    ].join(', '),
  },
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
 * Whether the selected arm samples on a distilled turbo schedule.
 *
 * Read off the arm's own parameter schema rather than matched on its id: an
 * arm that loads a turbo LoRA declares one, and that is the fact the controls
 * below actually depend on. Such an arm runs unguided on a fixed sigma
 * schedule, so guidance, the scheduler and the flow shift have nowhere to go.
 */
const isTurbo = computed(() => schemaProperty('turboLora') !== null);

/**
 * The pixel grid the selected model works in.
 *
 * Qwen-Image-Edit is 16 -- an 8x VAE with a 2x patch embed. Qwen-Image 2.1's
 * latent is a sixteenth scale with a further factor of two, so it is 32, and
 * asking it for 1040 is a job it refuses.
 */
const edgeMultiple = computed(() => (isTurbo.value ? SPATIAL_MULTIPLE : IMAGE_MULTIPLE));

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

// Start parameters: changing any of these restarts the arm, because all three
// decide how the weights are placed. The console says so rather than hiding it.
const weightDtype = ref('fp8_e4m3fn');
const textEncoderOnCpu = ref(false);
const vramMode = ref('dynamic');

const prompt = ref('');
// The style half. Kept apart from the subject only because the two change at
// different rates; they are joined into one prompt before anything is sent,
// and leaving this empty is how you write the whole prompt in one box.
const stylePrompt = ref('');
const negativePrompt = ref('');
const aspect = ref<string>('1:1');
const width = ref(1024);
const height = ref(1024);
// The distilled "rapid" merge that ships with this arm: four steps, unguided.
// The stock Qwen-Image-Edit 2511 wants 40 steps at CFG 4 instead, which is
// what ComfyUI's own blueprint uses and what the hint under Steps says.
const steps = ref(4);
const cfgScale = ref(1);
const sampler = ref('euler_ancestral');
const scheduler = ref('beta');
const flowShift = ref(3);
const seed = ref('');
const batch = ref(1);
/** Ask the arm to rewrite the prompt first. Only the turbo arm has a rewriter. */
const enhancePrompt = ref(false);

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
  Math.max(
    MIN_EDGE,
    Math.min(MAX_EDGE, Math.round(value / edgeMultiple.value) * edgeMultiple.value),
  );

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

/**
 * Switching arms brings that arm's own sampling settings with it.
 *
 * Only on a change of arm, which is a deliberate act -- the settings a
 * distilled six-step student wants are not the ones a guided model wants, and
 * carrying the old ones across is how you get four steps at CFG 1 on a model
 * that needed twenty, and wonder why the image is mud. The frame is left
 * alone: it is the thing people set first and mean.
 */
watch(isTurbo, (turbo, previous) => {
  if (previous === undefined) return;
  steps.value = turbo ? 6 : 4;
  cfgScale.value = 1;
  sampler.value = turbo ? 'euler' : 'euler_ancestral';
  scheduler.value = turbo ? 'simple' : 'beta';
  width.value = snap(width.value);
  height.value = snap(height.value);
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
  stylePrompt.value = meta.stylePrompt ?? '';
  negativePrompt.value = meta.negativePrompt ?? '';

  const ids = meta.referenceIds ?? (meta.referenceId ? [meta.referenceId] : []);
  referenceIds.value = ids.length < MAX_REFERENCES ? [...ids, null] : [...ids];

  const dtype = meta.armParams?.['weightDtype'];
  if (typeof dtype === 'string') weightDtype.value = dtype;
  const encoderDevice = meta.armParams?.['textEncoderDevice'];
  if (typeof encoderDevice === 'string') textEncoderOnCpu.value = encoderDevice === 'cpu';
  const mode = meta.armParams?.['vramMode'];
  if (typeof mode === 'string') vramMode.value = mode;

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

/**
 * Filled in once per record, not once per fetch.
 *
 * The library refetches after every upload and every generation, and hands back
 * a new object each time. Restoring on object identity meant a refetch refilled
 * the form underneath whoever was typing in it.
 */
let restored: string | null = null;

watch(
  () => props.restore,
  (meta) => {
    if (!meta) return;
    const key = restoreKey(meta);
    if (key === restored) return;
    restored = key;
    restoreFrom(meta);
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

/** What the model will be given: the two boxes as one prompt. */
const mergedPrompt = computed(() => mergePrompt(prompt.value, stylePrompt.value));

const canGenerate = computed(
  () => mergedPrompt.value.length > 0 && status.value === 'idle' && arm.value !== null,
);

function applyPreset(preset: (typeof STYLE_PRESETS)[number]): void {
  stylePrompt.value = preset.style;
  negativePrompt.value = preset.negative;
}

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
    ...(stylePrompt.value.trim() ? { stylePrompt: stylePrompt.value.trim() } : {}),
    ...(negativePrompt.value.trim() ? { negativePrompt: negativePrompt.value.trim() } : {}),
    ...(enhancePrompt.value ? { enhancePrompt: true } : {}),
    ...(chosenIds.value.length > 0 ? { referenceIds: chosenIds.value } : {}),
    armParams: {
      weightDtype: weightDtype.value,
      textEncoderDevice: textEncoderOnCpu.value ? 'cpu' : 'default',
      vramMode: vramMode.value,
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
              :step="edgeMultiple"
            />
          </UiField>
          <UiField label="Height" for="height">
            <UiNumberInput
              id="height"
              v-model="heightModel"
              lazy
              :min="MIN_EDGE"
              :max="MAX_EDGE"
              :step="edgeMultiple"
            />
          </UiField>
        </div>
        <p class="text-xs text-slate-500">
          {{ megapixelsOut.toFixed(2) }} MP &middot; actual ratio {{ actualRatio.toFixed(3) }}
        </p>
        <p class="text-xs text-slate-500">
          Either edge sets the other through the aspect; changing the aspect moves the height. Both land on
          a multiple of {{ edgeMultiple }}, which is the model's own grid.
        </p>
        <p v-if="aspect === REFERENCE_ASPECT && references[0]" class="text-xs text-slate-500">
          Shaped to {{ references[0].name }} ({{ references[0].width }}&#215;{{ references[0].height }}).
        </p>
      </fieldset>

      <div class="grid grid-cols-2 gap-3">
        <UiField label="Steps" for="steps">
          <UiNumberInput id="steps" v-model="steps" :min="1" :max="isTurbo ? 32 : 100" />
        </UiField>
        <UiField v-if="!isTurbo" label="CFG scale" for="cfg">
          <UiNumberInput id="cfg" v-model="cfgScale" :min="0" :max="30" :step="0.1" />
        </UiField>
        <UiField v-else label="Seed" for="seed-turbo">
          <UiInput id="seed-turbo" v-model="seed" placeholder="empty = random" />
        </UiField>
      </div>
      <p v-if="isTurbo" class="-mt-3 text-xs text-slate-500">
        Six steps is the schedule this LoRA was distilled for, and it samples unguided — there is no CFG,
        no scheduler and no flow shift to set, and the negative prompt does nothing. Extra steps subdivide
        the first, highest-noise part of the schedule, which is where composition is decided.
      </p>
      <p v-else class="-mt-3 text-xs text-slate-500">
        Four steps at CFG 1 is the distilled Rapid merge: it is trained to finish in that many and is
        unguided, so the negative prompt does nothing. Stock Qwen-Image-Edit 2511 wants 40 steps at CFG 4,
        which is what ComfyUI's own blueprint ships with.
      </p>

      <template v-if="!isTurbo">
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
      </template>
      <p class="-mt-3 text-xs text-slate-500">
        A batch increments the seed per image, and the library records the one each file actually used.
      </p>

      <fieldset class="space-y-2 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">How the weights are placed</legend>
        <UiField label="Transformer precision" for="dtype">
          <UiSelect id="dtype" v-model="weightDtype" :options="WEIGHT_DTYPES" />
        </UiField>
        <UiField label="VRAM strategy" for="vram-mode">
          <UiSelect id="vram-mode" v-model="vramMode" :options="VRAM_MODES" />
        </UiField>
        <UiCheckbox
          v-model="textEncoderOnCpu"
          label="Keep the text encoder on the CPU"
          :hint="
            isTurbo
              ? 'Qwen3-VL is most of the card it would otherwise share with the transformer. On the CPU it also makes the prompt enhancer far slower, because the enhancer is that same model generating text.'
              : 'Qwen2.5-VL is fifteen gigabytes of the card it would otherwise share with the transformer. On the CPU the prompt encode is slower, and on a 16 GiB card it is what stops the two of them fighting.'
          "
        />
        <p class="text-xs text-slate-500">
          All three are start parameters: changing any of them restarts ComfyUI, because placement is
          decided when the weights are read.
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
            Up to {{ MAX_REFERENCES }} — ComfyUI's Qwen edit encoder takes image1 through image3. They are
            composed into one scene rather than treated as alternatives, and the first one decides the
            frame's shape. With none, this is plain text-to-image.
          </template>
        </UiField>

        <UiField label="Prompt" for="prompt">
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

        <UiField label="Style" for="style">
          <UiTextarea
            id="style"
            v-model="stylePrompt"
            :rows="3"
            placeholder="How it should look — medium, lighting, palette, render"
          />
          <div v-if="STYLE_PRESETS.length" class="mt-2 flex flex-wrap items-center gap-2">
            <span class="text-xs text-slate-500">Presets:</span>
            <UiButton
              v-for="preset in STYLE_PRESETS"
              :key="preset.name"
              size="sm"
              :data-testid="`style-preset-${preset.name}`"
              @click="applyPreset(preset)"
            >
              {{ preset.name }}
            </UiButton>
          </div>
          <template #hint>
            Split from the prompt for editing only — the two are joined with a comma and sent as one, so
            writing everything above and leaving this empty gives exactly the same result. A preset also
            fills the negative prompt.
          </template>
        </UiField>

        <details v-if="stylePrompt.trim() && prompt.trim()" class="text-xs text-slate-500">
          <summary class="cursor-pointer hover:text-slate-300">What the model will be given</summary>
          <p class="mt-2 rounded-lg bg-black/30 p-3 font-mono leading-relaxed">{{ mergedPrompt }}</p>
        </details>

        <UiCheckbox
          v-if="isTurbo"
          v-model="enhancePrompt"
          label="Rewrite the prompt first"
          hint="Runs Qwen3-VL — the text encoder this arm already has loaded — over the prompt with the model's own rewriter instructions, then samples what it wrote. Once per job, not once per image. The library records both what you typed and what reached the model."
        />

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
            One load, {{ batch }} image{{ batch === 1 ? '' : 's' }}, each filed separately with its own
            seed. A batch costs no extra memory — it is one ComfyUI prompt per image — so the only price
            of a big one is that the card is busy until the last file is written.
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
            There is no torch in this arm to ask — the weights live in a ComfyUI child process — so its
            meter is nvidia-smi's. On a GeForce card under Windows that means a whole-card figure, and the
            two lines will sit on top of each other: the driver will not attribute memory per process.
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
