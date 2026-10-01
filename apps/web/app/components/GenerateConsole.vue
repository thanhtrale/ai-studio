<script setup lang="ts">
/**
 * The video console: settings, the work, and what the machine is doing with it.
 *
 * Three columns, because they answer three different questions and only the
 * middle one is input. The right-hand column is what makes a minutes-long run
 * bearable: it says which of load, enhance, encode or denoise is happening, and
 * what the card holds while it happens.
 *
 * Two arms sit behind it and they are not the same shape. A fixed-schedule
 * diffusers arm has upsamplers, an enhancer and one clip per request; a
 * distilled ComfyUI arm has a step count, a scheduler, a flow shift, two
 * keyframes and a batch -- which is the image console's panel exactly, because
 * it is the same bargain in a different modality. Which one is on show is read
 * off the arm's own parameter schema rather than matched on its id, the same
 * way the image console tells a turbo arm from a guided one.
 *
 * Nobody starts an arm here. A job names the arm and the configuration it needs
 * and the supervisor brokers the card into that state -- so the only thing the
 * Generate button waits for is a prompt.
 */
import { computed, ref, watch } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type {
  ArmGenerationReport,
  ArmVideoReport,
  GenerateRequest,
  GenerateResponse,
  VideoGenerateRequest,
  VideoGenerateResponse,
} from '#shared/generate';
import { mergePrompt } from '#shared/generate';
import { ratioLabel } from '#shared/image-size';
import {
  formatBytes,
  isVideoSettings,
  type MediaItem,
  type MediaMeta,
  type VideoJobSettings,
} from '#shared/library';

import {
  ASPECTS,
  aspectRatio,
  frameForRatio,
  h3Canvas,
  H3_FPS,
  latentTokens,
  REFERENCE_ASPECT,
  resolveDuration,
  resolveFrame,
  resolveH3Duration,
  resolveOutput,
  type Aspect,
  type Duration,
  type Frame,
} from '../utils/frame';
import { restoreKey } from '../utils/restore';
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

/**
 * A clip is minutes, not seconds, so the batch ceiling is a fraction of the
 * image console's. It is a guard against a mistyped number either way.
 */
const MAX_BATCH = 16;
const BATCH_PRESETS = [1, 2, 4, 8];

/**
 * Schedulers the arm passes straight through to ComfyUI's `BasicScheduler`.
 *
 * Spelled exactly as `comfy/samplers.py` spells them, and a curated subset:
 * the arm validates the *shape* of a name, so a ComfyUI that adds one needs no
 * change there, but a console offering all of them is not a kindness. There is
 * no sampler control beside it -- the turbo node supplies its own, because it
 * is the only one that steps the audio stream on the right clock.
 */
const SCHEDULERS = [
  { value: 'simple', label: 'simple — what the turbo LoRA was tuned against' },
  { value: 'beta', label: 'beta' },
  { value: 'normal', label: 'normal' },
  { value: 'karras', label: 'karras' },
  { value: 'sgm_uniform', label: 'sgm_uniform' },
  { value: 'linear_quadratic', label: 'linear_quadratic' },
  { value: 'kl_optimal', label: 'kl_optimal' },
];

const WEIGHT_DTYPES = [
  { value: 'default', label: 'default — the checkpoint’s own, right for an int8 file' },
  { value: 'fp8_e4m3fn', label: 'fp8_e4m3fn — only worth it on a bf16 checkpoint' },
  { value: 'fp8_e4m3fn_fast', label: 'fp8_e4m3fn_fast — also uses the card’s fp8 matmul' },
  { value: 'fp8_e5m2', label: 'fp8_e5m2 — more range, less precision' },
];

const VRAM_MODES = [
  { value: 'dynamic', label: 'dynamic — ComfyUI streams what will not fit' },
  { value: 'highvram', label: 'highvram — keep everything resident' },
  { value: 'lowvram', label: 'lowvram — split the model aggressively' },
  { value: 'novram', label: 'novram — when lowvram is not enough' },
];

const LORA_MODES = [
  { value: 'bypass', label: 'bypass — applied at run time, sharpest' },
  { value: 'merge', label: 'merge — folded into the weights, lowest VRAM, softer' },
];

/**
 * Why a peak might not be this arm's own.
 *
 * A GeForce card under Windows runs in WDDM mode, where the display driver owns
 * the allocations and nvidia-smi answers `[N/A]` for every process. A ComfyUI
 * arm then measures the whole card and says so rather than reporting a figure
 * that looks like its own share.
 */
const VRAM_SCOPE: Record<string, string> = {
  process: "this arm's child process",
  card: 'the whole card — this driver will not attribute memory per process',
  unavailable: 'nothing — nvidia-smi did not answer',
};

/**
 * Styles worth keeping, as the pair of prompts that produce them.
 *
 * Only the look: no subject, no motion, no framing. A preset that described a
 * shot would fight whatever is typed in the box below it, and the whole point
 * of the split is that the style survives a change of subject.
 */
const STYLE_PRESETS: { name: string; style: string; negative: string }[] = [
  {
    name: '3D xianxia',
    style: [
      'semi-realistic 3D rendered xianxia film look, Chinese fantasy wuxia aesthetic',
      'cinematic anamorphic photography, one slow deliberate camera move',
      'desaturated palette of ash grey and charcoal with deep crimson accents',
      'low-key volumetric lighting, cool overcast key light, warm rim light',
      'shallow depth of field, creamy bokeh, drifting snow and dust motes',
      'fine film grain, subtle chromatic aberration',
      'detailed silk, embroidery and blackened metal materials',
      'Audio: sparse guzheng and low strings, wind over stone, cloth movement, no dialogue',
    ].join(', '),
    negative: [
      'flat 2D cel shading, lineart, western cartoon, chibi',
      'blurry, out of focus, jpeg artifacts, lowres, motion smear, ghosting',
      'oversaturated, neon colours, flat frontal lighting, blown highlights',
      'bad anatomy, deformed hands, extra fingers, extra limbs',
      'watermark, signature, text, logo, subtitle bars, cropped',
      'modern clothing',
    ].join(', '),
  },
];

/** By declared capability: an arm that cannot take one of these jobs is not offered. */
const videoArms = computed(() => props.arms.filter((arm) => arm.capabilities.includes('video.generate')));
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

/**
 * Whether the selected arm samples on a distilled turbo schedule.
 *
 * Read off the arm's own parameter schema rather than matched on its id: an arm
 * that loads a turbo LoRA declares one, and that is the fact every control
 * below actually depends on. Such an arm runs unguided in a handful of steps,
 * takes a batch, and takes a last frame as well as a first.
 */
const isTurbo = computed(() => schemaProperty('turboLora') !== null);

/** First frame and last frame, against the diffusers arm's single still. */
const maxReferences = computed(() => (isTurbo.value ? 2 : 1));

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

const offloadSchema = computed(() => schemaProperty('offload'));

const offloadOptions = computed(() =>
  (offloadSchema.value?.enum ?? []).map((value) => ({ value, label: OFFLOAD_LABELS[value] ?? value })),
);

const offload = ref<string>('');
watch(
  offloadSchema,
  (schema) => {
    if (!offload.value && typeof schema?.default === 'string') offload.value = schema.default;
  },
  { immediate: true },
);

const prompt = ref('');
// The style half. Kept apart from the subject only because the two change at
// different rates; they are joined into one prompt before anything is sent,
// and leaving this empty is how you write the whole prompt in one box.
const stylePrompt = ref('');
const negativePrompt = ref('');
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

// The distilled arm's own controls.
const steps = ref(6);
const scheduler = ref('simple');
const flowShift = ref(12);
const batch = ref(1);
// Start parameters: changing any of these restarts the arm, because all of
// them decide how the weights are placed. The console says so rather than
// hiding it.
const weightDtype = ref('default');
const textEncoderOnCpu = ref(false);
const vramMode = ref('dynamic');
const loraMode = ref('bypass');

const referenceIds = ref<(string | null)[]>([null]);
/** Which reference slot the picker is filling, or null when it is closed. */
const picking = ref<number | null>(null);

const { byId, refresh: refreshMedia } = useMedia();

const chosenIds = computed(() => referenceIds.value.filter((id): id is string => id !== null));
const reference = computed(() => {
  const first = chosenIds.value[0];
  return first ? (byId.value.get(first) ?? null) : null;
});

/**
 * The first reference's own ratio, when one is chosen and its header was read.
 *
 * Worth offering above every named aspect: the still becomes the first frame,
 * so a frame shaped differently from it is one the model has to letterbox or
 * stretch before it can start.
 */
const referenceRatio = computed(() => {
  const item = reference.value;
  if (!item?.width || !item.height) return null;
  return { ratio: item.width / item.height, label: ratioLabel(item.width, item.height) };
});

/**
 * The exact geometry of a run being reused, when there is one.
 *
 * Aspect and megapixels do not determine a size on their own -- they are rounded
 * to what the model accepts -- so restoring only those would reproduce a run
 * approximately. This holds the frame the earlier run actually used, and any
 * touch of a size control drops it and hands the arithmetic back to the panel.
 *
 * It is also how the native-canvas button works: that size is not a megapixel
 * budget, it is the frame the model was trained at.
 */
const exact = ref<{ width: number; height: number; numFrames: number } | null>(null);

watch([aspect, megapixels, seconds, fps], () => (exact.value = null), { flush: 'sync' });

/** The shape being asked for: a named aspect, or the first reference's own. */
const ratio = computed(() =>
  aspect.value === REFERENCE_ASPECT
    ? (referenceRatio.value?.ratio ?? 1)
    : aspectRatio(aspect.value as Aspect),
);

const frame = computed<Frame>(() => {
  const fixed = exact.value;
  if (!fixed) {
    const matched = aspect.value === REFERENCE_ASPECT ? referenceRatio.value : null;
    return matched
      ? frameForRatio(matched.ratio, megapixels.value)
      : resolveFrame(aspect.value as Aspect, megapixels.value);
  }
  return {
    width: fixed.width,
    height: fixed.height,
    megapixels: (fixed.width * fixed.height) / 1_000_000,
    ratio: fixed.width / fixed.height,
  };
});

const duration = computed<Duration>(() => {
  const fixed = exact.value;
  if (fixed) return { numFrames: fixed.numFrames, seconds: fixed.numFrames / Math.max(1, fps.value) };
  // Two different temporal grids: `8n+1` at any frame rate, against `17k+5`
  // frames at a fixed 24 fps. Rounding to the wrong one leaves the arm to
  // round again behind the panel's back.
  return isTurbo.value ? resolveH3Duration(seconds.value) : resolveDuration(seconds.value, fps.value);
});

const output = computed(() =>
  resolveOutput(frame.value, duration.value, fps.value, spatialUpsample.value, temporalUpsample.value),
);
const tokens = computed(() => latentTokens(frame.value.width, frame.value.height, duration.value.numFrames));

const aspectOptions = computed(() => [
  ...(referenceRatio.value
    ? [{ value: REFERENCE_ASPECT, label: `match reference — ${referenceRatio.value.label}` }]
    : []),
  ...ASPECTS.map((option) => ({ value: option, label: option })),
]);

/** The model's native canvas at the chosen shape: 768 short edge, area capped. */
const nativeCanvas = computed(() => h3Canvas(ratio.value));

function useNativeCanvas(): void {
  exact.value = { ...nativeCanvas.value, numFrames: duration.value.numFrames };
}

/**
 * Switching arms brings that arm's own settings with it.
 *
 * Only on a change of arm, which is a deliberate act -- the fixed 24 fps and
 * the absent upsamplers are facts about the model, not preferences to carry
 * across. The frame is left alone: it is the thing people set first and mean.
 *
 * Synchronous, and skipped while a run is being restored: restoring sets the
 * arm and then that run's own settings, and a deferred watch would land second
 * and overwrite the real numbers with an arm default.
 */
let restoring = false;

watch(
  isTurbo,
  (turbo, previous) => {
    if (previous === undefined || restoring) return;
    if (turbo) {
      fps.value = H3_FPS;
      enhancePrompt.value = false;
      spatialUpsample.value = false;
      temporalUpsample.value = false;
    } else {
      batch.value = 1;
    }
    const kept = referenceIds.value.slice(0, maxReferences.value);
    referenceIds.value = kept.length > 0 ? kept : [null];
  },
  { flush: 'sync' },
);

/**
 * A reference arriving in the URL adopts its shape too, once its size is known.
 *
 * Arriving from the library's "animate this image" is the same deliberate act
 * as picking one in the modal, so it should behave the same -- but the index
 * may not have loaded when the parameter is first seen, so the adoption waits
 * for the ratio rather than happening with the assignment.
 */
const adoptShapeFor = ref<string | null>(null);

/**
 * Take a reference into the slot the picker was opened on, and its shape with
 * it when it is the first frame.
 *
 * Adopted straight away when the index already knows the image's size -- which
 * it does on the server, so the first paint is already the right shape rather
 * than a frame that changes under the reader. When it does not, the note below
 * picks it up as soon as the size arrives.
 */
function adoptReference(id: string | null): void {
  const slot = picking.value ?? 0;
  const next = [...referenceIds.value];
  next[slot] = id;
  // Keep the slots dense: a hole in the middle would send a list the arm reads
  // positionally, with the last frame in the first frame's place.
  const dense = next.filter((entry) => entry !== null);
  if (dense.length < maxReferences.value) dense.push(null);
  referenceIds.value = dense.length > 0 ? dense : [null];

  if (slot !== 0 || !id) return;
  if (byId.value.get(id)?.width) aspect.value = REFERENCE_ASPECT;
  else adoptShapeFor.value = id;
}

function removeReference(index: number): void {
  const next = referenceIds.value.filter((_, position) => position !== index);
  referenceIds.value = next.length > 0 ? next : [null];
  if (referenceIds.value.at(-1) !== null && referenceIds.value.length < maxReferences.value) {
    referenceIds.value.push(null);
  }
}

watch(referenceRatio, (current) => {
  // Chose "match reference" and then removed the reference: the panel must not
  // go on claiming a ratio it no longer has.
  if (!current && aspect.value === REFERENCE_ASPECT) aspect.value = '16:9';

  if (current && adoptShapeFor.value === chosenIds.value[0]) {
    aspect.value = REFERENCE_ASPECT;
    adoptShapeFor.value = null;
  }
}, { immediate: true });

/** Puts a previous run back into the form, exactly as it was asked for. */
function restoreFrom(meta: MediaMeta): void {
  restoring = true;
  try {
    applyRestore(meta);
  } finally {
    restoring = false;
  }
}

function applyRestore(meta: MediaMeta): void {
  const settings = meta.settings;
  // The arm first, and before anything else: the two video arms do not take
  // the same settings, so restoring a distilled ComfyUI run into the
  // diffusers panel would silently drop its steps, scheduler and batch.
  if (meta.armId && videoArms.value.some((candidate) => candidate.id === meta.armId)) {
    armId.value = meta.armId;
  }
  prompt.value = meta.prompt ?? '';
  stylePrompt.value = meta.stylePrompt ?? '';
  negativePrompt.value = meta.negativePrompt ?? '';

  const ids = meta.referenceIds ?? (meta.referenceId ? [meta.referenceId] : []);
  const kept: (string | null)[] = ids.slice(0, maxReferences.value);
  if (kept.length < maxReferences.value) kept.push(null);
  referenceIds.value = kept;

  const previousOffload = meta.armParams?.['offload'];
  if (typeof previousOffload === 'string') offload.value = previousOffload;
  const dtype = meta.armParams?.['weightDtype'];
  if (typeof dtype === 'string') weightDtype.value = dtype;
  const encoderDevice = meta.armParams?.['textEncoderDevice'];
  if (typeof encoderDevice === 'string') textEncoderOnCpu.value = encoderDevice === 'cpu';
  const mode = meta.armParams?.['vramMode'];
  if (typeof mode === 'string') vramMode.value = mode;
  const lora = meta.armParams?.['loraMode'];
  if (typeof lora === 'string') loraMode.value = lora;

  // An image record can reach this page through a hand-edited link. Its
  // prompt and reference still apply; none of its sampling settings do.
  if (!isVideoSettings(settings)) return;

  const known = [REFERENCE_ASPECT, ...ASPECTS] as readonly string[];
  if (settings.aspect && known.includes(settings.aspect)) aspect.value = settings.aspect;
  if (settings.megapixels) megapixels.value = settings.megapixels;
  if (settings.seconds) seconds.value = settings.seconds;
  fps.value = settings.frameRate;
  seed.value = `${settings.seed}`;
  enhancePrompt.value = settings.enhancePrompt;
  spatialUpsample.value = settings.spatialUpsample;
  temporalUpsample.value = settings.temporalUpsample;
  if (settings.steps !== undefined) steps.value = settings.steps;
  if (settings.scheduler) scheduler.value = settings.scheduler;
  if (settings.flowShift !== undefined) flowShift.value = settings.flowShift;
  if (settings.batch !== undefined) batch.value = settings.batch;
  // Last, because the assignments above each clear it.
  exact.value = { width: settings.width, height: settings.height, numFrames: settings.numFrames };
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

// The prop is optional, so an absent parameter and an explicit null are the
// same thing here. It always fills the first slot: a link from the library
// means "start from this image", not "end on it".
watch(
  () => props.initialReference,
  (id) => {
    if (!id) return;
    picking.value = 0;
    adoptReference(id);
    picking.value = null;
  },
  { immediate: true },
);

const status = ref<'idle' | 'generating'>('idle');
const failure = ref<string | null>(null);
/** The diffusers arm's single clip, with the report that came with it. */
const result = ref<{ media: MediaItem; report: ArmGenerationReport } | null>(null);
/** The ComfyUI arm's batch, and the one clip currently in the player. */
const clips = ref<MediaItem[]>([]);
const clipReport = ref<ArmVideoReport | null>(null);
const playing = ref<MediaItem | null>(null);

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

function settingsNow(): VideoJobSettings {
  const typed = seed.value.trim();
  const chosen = typed === '' ? -1 : Number(typed);

  return {
    kind: 'video',
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
    ...(isTurbo.value
      ? {
          steps: steps.value,
          scheduler: scheduler.value,
          flowShift: flowShift.value,
          batch: batch.value,
          // Overwritten per file by the server, which knows which one each is.
          batchIndex: 0,
        }
      : {}),
  };
}

async function generate(): Promise<void> {
  if (!canGenerate.value || !arm.value) return;

  status.value = 'generating';
  failure.value = null;
  result.value = null;
  clips.value = [];
  clipReport.value = null;
  playing.value = null;

  const settings = settingsNow();
  // Chosen here rather than returned by the server: the run takes minutes, and
  // the console has to be able to ask about it while the request is still open.
  const jobId = crypto.randomUUID();
  const path = `/api/arms/${encodeURIComponent(arm.value.id)}/${isTurbo.value ? 'video' : 'generate'}`;

  follow(jobId);

  try {
    if (isTurbo.value) {
      const body: VideoGenerateRequest = {
        jobId,
        prompt: prompt.value.trim(),
        settings,
        output: output.value,
        ...(stylePrompt.value.trim() ? { stylePrompt: stylePrompt.value.trim() } : {}),
        ...(negativePrompt.value.trim() ? { negativePrompt: negativePrompt.value.trim() } : {}),
        ...(chosenIds.value.length > 0 ? { referenceIds: chosenIds.value } : {}),
        armParams: {
          weightDtype: weightDtype.value,
          textEncoderDevice: textEncoderOnCpu.value ? 'cpu' : 'default',
          vramMode: vramMode.value,
          loraMode: loraMode.value,
        },
      };
      const answer = await $fetch<VideoGenerateResponse>(path, { method: 'POST', body });
      clips.value = answer.media;
      clipReport.value = answer.report;
      playing.value = answer.media[0] ?? null;
    } else {
      const body: GenerateRequest = {
        jobId,
        // One box for this arm, so the style half is folded in rather than
        // dropped: it has no `stylePrompt` field to keep the halves apart.
        prompt: mergedPrompt.value,
        settings,
        output: output.value,
        ...(negativePrompt.value.trim() ? { negativePrompt: negativePrompt.value.trim() } : {}),
        ...(chosenIds.value[0] ? { referenceId: chosenIds.value[0] } : {}),
        ...(offload.value ? { armParams: { offload: offload.value } } : {}),
      };
      result.value = await $fetch<GenerateResponse>(path, { method: 'POST', body });
    }
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
        :hint="
          isTurbo
            ? 'text-to-video, first/last-frame video, a few distilled steps, picture and stereo audio denoised together'
            : 'text-to-video, image-to-video, eight distilled steps, video and audio together'
        "
      >
        <UiSelect id="arm" v-model="armId" :options="armOptions" />
      </UiField>

      <UiCheckbox
        v-if="!isTurbo"
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
        <template v-if="isTurbo">
          <UiButton size="sm" data-testid="native-canvas" @click="useNativeCanvas">
            Native canvas — {{ nativeCanvas.width }}&#215;{{ nativeCanvas.height }}
          </UiButton>
          <p class="text-xs text-slate-500">
            A 768-pixel short edge under a 768&#215;1344 area cap is what this model was trained at. Above
            it there is nothing to recover the detail: the 2K pass is a hosted service rather than part of
            these weights.
          </p>
        </template>
        <p v-if="!exact && aspect === REFERENCE_ASPECT && reference" class="text-xs text-slate-500">
          Shaped to {{ reference.name }} ({{ reference.width }}&#215;{{ reference.height }}).
        </p>
        <p v-if="exact" class="text-xs text-indigo-300/80">
          Exact frame. Changing any size control returns to the aspect and megapixel arithmetic.
        </p>
      </fieldset>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-slate-200">Duration</legend>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Seconds" for="seconds">
            <UiNumberInput id="seconds" v-model="seconds" :min="0.5" :max="20" :step="0.5" />
          </UiField>
          <UiField v-if="!isTurbo" label="FPS" for="fps">
            <UiNumberInput id="fps" v-model="fps" :min="8" :max="60" />
          </UiField>
          <UiField v-else label="Seed" for="seed-turbo">
            <UiInput id="seed-turbo" v-model="seed" placeholder="empty = random" />
          </UiField>
        </div>
        <p class="text-xs text-slate-500">
          <span class="text-slate-300">{{ duration.numFrames }}</span> frames &middot;
          {{ duration.seconds.toFixed(2) }} s actual
        </p>
        <p v-if="isTurbo" class="text-xs text-slate-500">
          Lengths are 17k&nbsp;+&nbsp;5 frames at a fixed 24&nbsp;fps — 124 is about five seconds, 362
          about fifteen, and nothing exists between the steps. The frame rate is not a setting: the audio
          latents are sized from the clip's duration in seconds.
        </p>
      </fieldset>

      <template v-if="isTurbo">
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Steps" for="steps">
            <UiNumberInput id="steps" v-model="steps" :min="1" :max="32" />
          </UiField>
          <UiField label="Scheduler" for="scheduler">
            <UiSelect id="scheduler" v-model="scheduler" :options="SCHEDULERS" />
          </UiField>
        </div>
        <p class="-mt-3 text-xs text-slate-500">
          Four steps is the LoRA's floor and eight its ceiling; six is the knee. Past eight it stops
          helping and starts over-sharpening. It samples unguided — there is no CFG to set, no sampler to
          choose, and the negative prompt does nothing.
        </p>

        <UiField label="Flow shift" for="flow">
          <UiNumberInput id="flow" v-model="flowShift" :min="0.5" :max="30" :step="0.5" />
          <template #hint>
            The picture stream's sigma shift; the audio stream's is derived from it, so the two stay on one
            clock. 12 is what the model ships with.
          </template>
        </UiField>
      </template>

      <UiField
        v-if="!isTurbo"
        label="Seed"
        for="seed"
        hint="Empty picks one at random and the library records which."
      >
        <UiInput id="seed" v-model="seed" placeholder="empty = random" />
      </UiField>

      <p v-if="isTurbo" class="-mt-1 text-xs text-slate-500">
        A batch increments the seed per clip, and the library records the one each file actually used.
      </p>

      <UiField v-if="offloadOptions.length > 0" label="Offload" for="offload">
        <UiSelect id="offload" v-model="offload" :options="offloadOptions" />
        <template #hint>
          How weights reach the card. Changing it reloads the arm, because placement is decided when the
          weights are read.
        </template>
      </UiField>

      <fieldset v-if="!isTurbo" class="space-y-2">
        <legend class="text-sm font-medium text-slate-200">Upsamplers</legend>
        <UiCheckbox v-model="spatialUpsample" label="Spatial (&#215;2 edge)" />
        <UiCheckbox v-model="temporalUpsample" label="Temporal (&#215;2 frames, same duration)" />
        <p class="text-xs text-slate-500">
          Lightricks' own latent upsamplers. Each runs a further denoising round on what it upsampled, so
          the model redraws detail rather than interpolating it.
        </p>
      </fieldset>

      <fieldset v-if="isTurbo" class="space-y-2 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">How the weights are placed</legend>
        <UiField label="Transformer precision" for="dtype">
          <UiSelect id="dtype" v-model="weightDtype" :options="WEIGHT_DTYPES" />
        </UiField>
        <UiField label="VRAM strategy" for="vram-mode">
          <UiSelect id="vram-mode" v-model="vramMode" :options="VRAM_MODES" />
        </UiField>
        <UiField label="LoRA" for="lora-mode">
          <UiSelect id="lora-mode" v-model="loraMode" :options="LORA_MODES" />
        </UiField>
        <UiCheckbox
          v-model="textEncoderOnCpu"
          label="Keep the text encoder on the CPU"
          hint="Qwen3-VL 32B is more than a 16 GiB card holds on its own. On the CPU the prompt encode is slower, once per job, and the transformer gets the card to itself."
        />
        <p class="text-xs text-slate-500">
          All four are start parameters: changing any of them restarts ComfyUI, because placement is
          decided when the weights are read.
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
            <span v-if="isTurbo">
              State the whole scene first, then break it into timed shots, and describe the audio —
              dialogue, effects, music — in the same block. The audio is generated with the picture rather
              than added to it.
            </span>
            <span v-else>
              The model was trained on long single-paragraph audio-visual captions and degrades on short
              prompts. The enhancer rewrites a short one into that style.
            </span>
          </template>
        </UiField>

        <UiField label="Style" for="style">
          <UiTextarea
            id="style"
            v-model="stylePrompt"
            :rows="3"
            placeholder="How it should look — medium, lighting, palette, camera, score"
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

        <UiField :label="isTurbo ? 'Keyframes' : 'Reference image'">
          <div class="flex flex-wrap items-start gap-3">
            <div v-for="(id, index) in referenceIds" :key="`${index}-${id ?? 'empty'}`" class="space-y-1">
              <button
                type="button"
                class="h-24 w-32 shrink-0 overflow-hidden rounded-lg border border-dashed border-white/20 text-xs text-slate-500 transition-colors hover:border-white/40 hover:text-slate-300"
                :data-testid="index === 0 ? 'open-picker' : `reference-${index}`"
                @click="picking = index"
              >
                <MediaThumb v-if="id && byId.get(id)" :item="byId.get(id) as MediaItem" fit="contain" />
                <span v-else>{{ index === 0 ? 'Choose or upload' : '+ Last frame' }}</span>
              </button>
              <p v-if="isTurbo" class="w-32 text-center text-[10px] text-slate-500">
                {{ index === 0 ? 'first frame' : 'last frame' }}
              </p>
              <button
                v-if="id"
                type="button"
                class="block w-32 text-center text-[10px] text-slate-500 hover:text-rose-300"
                @click="removeReference(index)"
              >
                remove
              </button>
            </div>
            <UiBadge v-if="reference" tone="accent">image-to-video</UiBadge>
          </div>
          <template #hint>
            <span v-if="isTurbo">
              Positional, up to {{ maxReferences }}: the first still opens the clip and the second closes
              it, and the model generates the motion between them. With neither, this is plain
              text-to-video.
            </span>
            <span v-else>
              A reference switches the run to image-to-video: the still becomes the first frame and the
              clip moves on from it.
            </span>
          </template>
        </UiField>

        <UiField v-if="isTurbo" label="Batch">
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
            One load, {{ batch }} clip{{ batch === 1 ? '' : 's' }}, each filed separately with its own
            seed. A batch costs no extra memory — it is one ComfyUI prompt per clip — but a clip is
            minutes, so the card is busy until the last file is written.
          </template>
        </UiField>

        <UiField label="Negative prompt" for="negative">
          <UiTextarea
            id="negative"
            v-model="negativePrompt"
            :rows="2"
            placeholder="What to keep out of the clip"
          />
          <template #hint>
            Only does something where the model is guided. These checkpoints are distilled to sample
            unguided, so there is nothing to steer away from.
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

        <section v-if="clips.length" class="space-y-3">
          <video
            v-if="playing"
            :key="playing.id"
            :src="mediaUrl(playing.id)"
            class="w-full rounded-lg border border-white/10"
            controls
            autoplay
            loop
          />
          <ul v-if="clips.length > 1" class="grid grid-cols-3 gap-3 sm:grid-cols-4">
            <li v-for="item in clips" :key="item.id">
              <button
                type="button"
                class="w-full overflow-hidden rounded-lg border text-left"
                :class="
                  playing?.id === item.id ? 'border-indigo-400/70' : 'border-white/10 hover:border-white/30'
                "
                @click="playing = item"
              >
                <div class="aspect-video"><MediaThumb :item="item" fit="contain" /></div>
                <p class="px-2 py-1 font-mono text-[10px] text-slate-500">
                  seed {{ item.meta?.settings?.seed }}
                </p>
              </button>
            </li>
          </ul>
          <div v-if="clipReport" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{{ clipReport.seconds_total.toFixed(1) }} s</span>
            <span>{{ clipReport.videos.length }} clip{{ clipReport.videos.length === 1 ? '' : 's' }}</span>
            <span>{{ formatBytes(clipReport.videos.reduce((sum, one) => sum + one.out_bytes, 0)) }}</span>
            <span>{{ clipReport.steps }} step</span>
            <span>{{ clipReport.num_frames }} frames @ {{ clipReport.frame_rate }} fps</span>
            <span :title="VRAM_SCOPE[clipReport.vram_scope]">
              peak {{ clipReport.peak_vram_gib.toFixed(2) }} GiB
              <span v-if="clipReport.vram_scope !== 'process'" class="text-slate-500">
                ({{ clipReport.vram_scope === 'card' ? 'whole card' : 'unmeasured' }})
              </span>
            </span>
            <NuxtLink
              v-if="clips[0]"
              :to="{ path: '/library', query: { folder: clips[0].group, item: clips[0].id } }"
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

        <div v-if="!job" class="space-y-2 text-sm text-slate-500">
          <p>
            The chart runs whether or not this studio does — what the card already holds is most of the gap
            between the two meters. A job's own steps appear here once one is submitted.
          </p>
          <p v-if="isTurbo" class="text-xs">
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
      @select="adoptReference"
    />
  </div>
</template>
