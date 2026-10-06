<script setup lang="ts">
/**
 * The 3D console: one photograph in, a GLB a three.js page can load out.
 *
 * Two engines behind one form, both textured. TRELLIS.2 gets there through
 * four sampling passes and a bake; Hunyuan3D Paint makes Hunyuan3D 2.1's
 * shape and then runs Tencent's multiview PBR paint stage on it. The
 * arm's own parameter schema says which it is, and the form shows that
 * engine's knobs -- the shared ones (seed, guidance, faces, cut-out) stay put.
 *
 * The same three columns as the image and video consoles, and the same rule
 * about arms: a job names the arm and the configuration it needs, the
 * supervisor brokers the card into that state, and nobody presses Start.
 *
 * What is different is the result. A mesh is judged by turning it over, so the
 * middle column ends in a live viewer -- the same loader and material a page
 * would use -- rather than a grid of pictures.
 */
import { computed, ref, watch } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { ArmMeshReport, MeshGenerateRequest, MeshGenerateResponse } from '#shared/generate';
import {
  formatBytes,
  formatCount,
  isModelSettings,
  type MediaItem,
  type MediaMeta,
  type MeshEngine,
  type ModelJobSettings,
} from '#shared/library';

import { restoreKey } from '../utils/restore';
import JobTimeline from './JobTimeline.vue';
import MediaPicker from './MediaPicker.vue';
import MediaThumb from './MediaThumb.vue';
import ModelViewer from './ModelViewer.vue';
import VramChart from './VramChart.vue';
import UiAlert from './ui/Alert.vue';
import UiButton from './ui/Button.vue';
import UiCheckbox from './ui/Checkbox.vue';
import UiField from './ui/Field.vue';
import UiInput from './ui/Input.vue';
import UiNumberInput from './ui/NumberInput.vue';
import UiSelect from './ui/Select.vue';

const props = defineProps<{
  arms: ArmSummary[];
  /** A previous run to restore, from `?from=` on the page. */
  restore?: MediaMeta | null;
  /** The photograph to start from, from `?reference=` on the page. */
  initialReference?: string | null;
}>();

/** Each mesh is a minute or more of card time; the ceiling guards a typo. */
const MAX_BATCH = 8;
const BATCH_PRESETS = [1, 2, 4];

const VRAM_SCOPE: Record<string, string> = {
  process: "this arm's child process",
  card: 'the whole card — this driver will not attribute memory per process',
  unavailable: 'nothing — nvidia-smi did not answer',
};

/**
 * TRELLIS.2's recipes. Web is Microsoft's default sampling with an output a
 * page can carry; the template's own 700K faces and 4096 maps are a 50 MB file.
 */
const TRELLIS_PRESETS: { name: string; hint: string; values: Partial<ModelJobSettings> }[] = [
  {
    name: 'Draft',
    hint: 'Fewer steps and a 1K texture — for checking the photo reads as an object at all.',
    values: {
      structureSteps: 8,
      shapeSteps: 12,
      refineSteps: 8,
      textureSteps: 8,
      shapeResolution: 1024,
      textureSize: 1024,
      targetFaces: 30_000,
    },
  },
  {
    name: 'Web',
    hint: 'The template’s sampling, 100K faces and 2K maps — what a product page can stream.',
    values: {
      structureSteps: 12,
      shapeSteps: 20,
      refineSteps: 12,
      textureSteps: 12,
      shapeResolution: 1024,
      textureSize: 2048,
      targetFaces: 100_000,
    },
  },
  {
    name: 'Detailed',
    hint: 'Shape refined at 1536 with 4K maps — for a hero model. Slower, and more of the card.',
    values: {
      structureSteps: 12,
      shapeSteps: 20,
      refineSteps: 12,
      textureSteps: 12,
      shapeResolution: 1536,
      textureSize: 4096,
      targetFaces: 300_000,
    },
  },
];

/**
 * Hunyuan3D Paint's recipes. Web is Tencent's own: 40K faces, six views at
 * 512 -- the paint stage is drawn per view, so faces cost unwrap time, not paint.
 */
const PAINT_PRESETS: { name: string; hint: string; values: Partial<ModelJobSettings> }[] = [
  {
    name: 'Draft',
    hint: 'Fewer steps, a 1K texture and no upscale — for checking the photo reads at all.',
    values: {
      steps: 20,
      octreeResolution: 192,
      targetFaces: 20_000,
      paintViews: 6,
      paintResolution: 512,
      textureSize: 1024,
      upscale: false,
    },
  },
  {
    name: 'Web',
    hint: 'Tencent’s defaults: 40K faces, six views at 512, upscaled and baked to a 2K texture.',
    values: {
      steps: 30,
      octreeResolution: 256,
      targetFaces: 40_000,
      paintViews: 6,
      paintResolution: 512,
      textureSize: 2048,
      upscale: true,
    },
  },
  {
    name: 'Detailed',
    hint: 'Octree 384, 100K faces, eight views at 768 and a 4K texture — the official app’s paint settings.',
    values: {
      steps: 50,
      octreeResolution: 384,
      targetFaces: 100_000,
      paintViews: 8,
      paintResolution: 768,
      textureSize: 4096,
      upscale: true,
    },
  },
];

const PAINT_VIEWS = [
  { value: '6', label: '6 — four sides, top and bottom' },
  { value: '7', label: '7' },
  { value: '8', label: '8 — the official app’s' },
  { value: '9', label: '9' },
];

const PAINT_RESOLUTIONS = [
  { value: '512', label: '512 — the default' },
  { value: '768', label: '768 — sharper, more of the card' },
];

const PAINT_TEXTURE_SIZES = [
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048 — web' },
  { value: '4096', label: '4096' },
];

const FACE_PRESETS = [10_000, 25_000, 50_000, 100_000, 200_000];

const SHAPE_RESOLUTIONS = [
  { value: '1024', label: '1024 — fits the card comfortably' },
  { value: '1536', label: '1536 — the template’s, finer and heavier' },
];

/**
 * The TRELLIS.2 transformer, as a start parameter: a different file is a
 * different load, which is exactly what the broker restarts an arm for.
 */
const TRANSFORMERS = [
  { value: 'models/trellis2/trellis_2_bf16.safetensors', label: 'bf16 — 10.3 GB, full precision, streams' },
  { value: 'models/trellis2/trellis_2_int8_convrot.safetensors', label: 'int8 — 5.3 GB, stays on the card' },
];

const TEXTURE_SIZES = [
  { value: '512', label: '512' },
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048 — web' },
  { value: '4096', label: '4096 — the template’s' },
];

const OCTREES = [
  { value: '128', label: '128 — blocky, fastest' },
  { value: '192', label: '192' },
  { value: '256', label: '256 — the blueprint’s' },
  { value: '320', label: '320' },
  { value: '384', label: '384 — sharpest, ~3× the decode' },
];

const VRAM_MODES = [
  { value: 'dynamic', label: 'dynamic — ComfyUI decides what to stream' },
  { value: 'highvram', label: 'highvram — keep everything resident' },
  { value: 'lowvram', label: 'lowvram — split the model aggressively' },
];

const meshArms = computed(() => props.arms.filter((arm) => arm.capabilities.includes('mesh.generate')));
const armId = ref<string>('');

type Schema = { properties?: Record<string, { default?: unknown }> } | null;

/**
 * The engines this console drives. `hunyuan3d` stays in `MeshEngine` for the
 * library's older records, made by the untextured ComfyUI arm that is gone.
 */
type ConsoleEngine = Exclude<MeshEngine, 'hunyuan3d'>;

function engineOf(candidate: ArmSummary): ConsoleEngine {
  // Read off the arm's schema rather than its id: an arm with a paint model
  // paints, one that loads a texture VAE bakes.
  return (candidate.paramsSchema as Schema)?.properties?.['paintDir'] ? 'hunyuan3d-paint' : 'trellis2';
}

watch(
  meshArms,
  (list) => {
    // Textured first: it is the one that gives a page something to show.
    const preferred = list.find((candidate) => engineOf(candidate) === 'trellis2') ?? list[0];
    if (!armId.value && preferred) armId.value = preferred.id;
  },
  { immediate: true },
);

const armOptions = computed(() => meshArms.value.map((arm) => ({ value: arm.id, label: arm.name })));
const arm = computed(() => meshArms.value.find((candidate) => candidate.id === armId.value) ?? null);

const engine = computed<ConsoleEngine>(() => (arm.value ? engineOf(arm.value) : 'trellis2'));
const presets = computed(() => (engine.value === 'trellis2' ? TRELLIS_PRESETS : PAINT_PRESETS));

const armHint = computed(() => {
  if (!arm.value) return 'No arm declares mesh.generate. Check capabilities in a manifest under arms/.';
  const properties = (arm.value.paramsSchema as Schema)?.properties;
  if (engine.value === 'hunyuan3d-paint') return 'hunyuan3d-dit-v2-1 + paintpbr-v2-1 · textured (PBR)';
  const model = properties?.['checkpoint']?.default ?? properties?.['diffusionModel']?.default;
  const name = typeof model === 'string' ? (model.split('/').pop() ?? model) : arm.value.id;
  return `${name} · textured`;
});

const vramMode = ref('dynamic');

const steps = ref(30);
const cfgScale = ref(5);
const octree = ref('256');
const targetFaces = ref(50_000);
const removeBackground = ref(true);
// TRELLIS.2's own: four passes, the refine resolution, and the bake.
const structureSteps = ref(12);
const shapeSteps = ref(20);
const refineSteps = ref(12);
const textureSteps = ref(12);
const shapeResolution = ref('1024');
const textureSize = ref('2048');
const bakeNormals = ref(true);
const bakeOcclusion = ref(true);
// Hunyuan3D Paint's own: the paint stage, and whether to run it at all.
const paintTexture = ref(true);
const paintViews = ref('6');
const paintResolution = ref('512');
const paintSteps = ref(15);
const paintGuidance = ref(3);
const upscale = ref(true);
/**
 * WebP quality for the baked maps, 1-100. 100 is lossless -- every pixel as
 * baked, about a quarter smaller than PNG -- and is the default, so nothing is
 * given up unless someone drags it. Below that the maps are lossy at that
 * quality: on the test chair's 2048 maps, 90% was a sixth of the PNGs.
 */
const textureQuality = ref(100);
const qualityLabel = computed(() =>
  textureQuality.value >= 100 ? '100% · lossless' : `${textureQuality.value}% · lossy`,
);
/** Measured on the test chair's three 2048 maps: 9.4 MB as PNG. */
const QUALITY_SIZES: [number, string][] = [
  [100, '≈ 6.9 MB at 2048 (lossless)'],
  [90, '≈ 1.5 MB at 2048'],
  [75, '≈ 0.7 MB at 2048'],
  [0, '≈ 0.5 MB or less at 2048'],
];
const qualityHint = computed(
  () => QUALITY_SIZES.find(([floor]) => textureQuality.value >= floor)?.[1] ?? '',
);
const transformer = ref(TRANSFORMERS[0]!.value);
const seed = ref('');
const batch = ref(1);
const note = ref('');

const referenceId = ref<string | null>(null);
const picking = ref(false);

const { byId, refresh: refreshMedia } = useMedia();
const reference = computed(() => (referenceId.value ? (byId.value.get(referenceId.value) ?? null) : null));

const activePreset = computed(
  () =>
    presets.value.find((preset) => {
      const values = preset.values;
      if (values.targetFaces !== targetFaces.value) return false;
      if (engine.value === 'hunyuan3d-paint') {
        return (
          values.steps === steps.value &&
          `${values.octreeResolution}` === octree.value &&
          `${values.paintViews}` === paintViews.value &&
          `${values.paintResolution}` === paintResolution.value &&
          `${values.textureSize}` === textureSize.value &&
          values.upscale === upscale.value
        );
      }
      return (
        values.structureSteps === structureSteps.value &&
        values.shapeSteps === shapeSteps.value &&
        values.refineSteps === refineSteps.value &&
        values.textureSteps === textureSteps.value &&
        `${values.shapeResolution}` === shapeResolution.value &&
        `${values.textureSize}` === textureSize.value
      );
    })?.name ?? null,
);

function applyPreset(preset: (typeof TRELLIS_PRESETS)[number]): void {
  const values = preset.values;
  if (values.steps !== undefined) steps.value = values.steps;
  if (values.octreeResolution !== undefined) octree.value = `${values.octreeResolution}`;
  if (values.targetFaces !== undefined) targetFaces.value = values.targetFaces;
  if (values.structureSteps !== undefined) structureSteps.value = values.structureSteps;
  if (values.shapeSteps !== undefined) shapeSteps.value = values.shapeSteps;
  if (values.refineSteps !== undefined) refineSteps.value = values.refineSteps;
  if (values.textureSteps !== undefined) textureSteps.value = values.textureSteps;
  if (values.shapeResolution !== undefined) shapeResolution.value = `${values.shapeResolution}`;
  if (values.textureSize !== undefined) textureSize.value = `${values.textureSize}`;
  if (values.paintViews !== undefined) paintViews.value = `${values.paintViews}`;
  if (values.paintResolution !== undefined) paintResolution.value = `${values.paintResolution}`;
  if (values.upscale !== undefined) upscale.value = values.upscale;
}

/** The record the form was last filled from; see `restoreKey`. */
let restored: string | null = null;

/**
 * Switching engines brings that engine's own guidance and face budget.
 *
 * Only on a change of arm, which is a deliberate act: Hunyuan3D's CFG 5 is
 * not TRELLIS.2's 7.5, and a raw-surface 0 is a face count TRELLIS.2 cannot
 * bake a texture onto.
 */
watch(
  engine,
  (current, previous) => {
    if (current === previous) return;
    // The first engine is a choice too -- the page preselects TRELLIS.2 --
    // unless a restored run already filled the form in.
    if (previous === undefined && restored !== null) return;
    cfgScale.value = current === 'trellis2' ? 7.5 : 5;
    targetFaces.value = current === 'trellis2' ? 100_000 : 40_000;
  },
  { immediate: true },
);

function restoreFrom(meta: MediaMeta): void {
  note.value = meta.prompt ?? '';
  referenceId.value = meta.referenceId ?? null;

  const mode = meta.armParams?.['vramMode'];
  if (typeof mode === 'string') vramMode.value = mode;
  const model = meta.armParams?.['diffusionModel'];
  if (typeof model === 'string' && TRANSFORMERS.some((option) => option.value === model)) {
    transformer.value = model;
  }

  // The arm that made it, if it is still here: the settings below only mean
  // something to that engine.
  if (meta.armId && meshArms.value.some((candidate) => candidate.id === meta.armId)) armId.value = meta.armId;

  const settings = meta.settings;
  if (!isModelSettings(settings)) return;
  steps.value = settings.steps;
  cfgScale.value = settings.cfgScale;
  if (settings.octreeResolution) octree.value = `${settings.octreeResolution}`;
  if (settings.structureSteps) structureSteps.value = settings.structureSteps;
  if (settings.shapeSteps) shapeSteps.value = settings.shapeSteps;
  if (settings.refineSteps) refineSteps.value = settings.refineSteps;
  if (settings.textureSteps) textureSteps.value = settings.textureSteps;
  if (settings.shapeResolution) shapeResolution.value = `${settings.shapeResolution}`;
  if (settings.textureSize) textureSize.value = `${settings.textureSize}`;
  if (settings.bakeNormals !== undefined) bakeNormals.value = settings.bakeNormals;
  if (settings.bakeOcclusion !== undefined) bakeOcclusion.value = settings.bakeOcclusion;
  if (settings.textureQuality !== undefined) textureQuality.value = settings.textureQuality;
  if (settings.texture !== undefined) paintTexture.value = settings.texture;
  if (settings.paintViews) paintViews.value = `${settings.paintViews}`;
  if (settings.paintResolution) paintResolution.value = `${settings.paintResolution}`;
  if (settings.paintSteps) paintSteps.value = settings.paintSteps;
  if (settings.paintGuidance) paintGuidance.value = settings.paintGuidance;
  if (settings.upscale !== undefined) upscale.value = settings.upscale;
  targetFaces.value = settings.targetFaces;
  removeBackground.value = settings.removeBackground;
  seed.value = `${settings.seed}`;
  batch.value = settings.batch;
}

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
    if (id) referenceId.value = id;
  },
  { immediate: true },
);

const status = ref<'idle' | 'generating'>('idle');
const failure = ref<string | null>(null);
const results = ref<MediaItem[]>([]);
const report = ref<ArmMeshReport | null>(null);
const shown = ref<MediaItem | null>(null);

const { job, machine, armVram, capacityGib, available, elapsedSeconds, watch: follow, stopWatching } =
  useJobTelemetry();

const canGenerate = computed(() => referenceId.value !== null && status.value === 'idle' && arm.value !== null);

async function generate(): Promise<void> {
  if (!canGenerate.value || !arm.value || !referenceId.value) return;

  status.value = 'generating';
  failure.value = null;
  results.value = [];
  report.value = null;
  shown.value = null;

  const typed = seed.value.trim();
  const chosen = typed === '' ? -1 : Number(typed);

  const common = {
    kind: 'model' as const,
    engine: engine.value,
    cfgScale: cfgScale.value,
    targetFaces: targetFaces.value,
    removeBackground: removeBackground.value,
    seed: Number.isFinite(chosen) ? chosen : -1,
    batch: batch.value,
    batchIndex: 0,
  };
  const settings: ModelJobSettings =
    engine.value === 'trellis2'
      ? {
          ...common,
          steps: structureSteps.value + shapeSteps.value + refineSteps.value + textureSteps.value,
          structureSteps: structureSteps.value,
          shapeSteps: shapeSteps.value,
          refineSteps: refineSteps.value,
          textureSteps: textureSteps.value,
          shapeResolution: Number(shapeResolution.value),
          textureSize: Number(textureSize.value),
          bakeNormals: bakeNormals.value,
          bakeOcclusion: bakeOcclusion.value,
          compressTextures: true,
          textureQuality: textureQuality.value,
        }
      : {
          ...common,
          steps: steps.value,
          octreeResolution: Number(octree.value),
          texture: paintTexture.value,
          paintViews: Number(paintViews.value),
          paintResolution: Number(paintResolution.value),
          paintSteps: paintSteps.value,
          paintGuidance: paintGuidance.value,
          textureSize: Number(textureSize.value),
          upscale: upscale.value,
          compressTextures: true,
          textureQuality: textureQuality.value,
        };

  const jobId = crypto.randomUUID();
  const body: MeshGenerateRequest = {
    jobId,
    referenceId: referenceId.value,
    settings,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
    // The paint arm has no ComfyUI, so no VRAM strategy to pass it.
    armParams:
      engine.value === 'hunyuan3d-paint'
        ? {}
        : {
            vramMode: vramMode.value,
            ...(engine.value === 'trellis2' ? { diffusionModel: transformer.value } : {}),
          },
  };

  follow(jobId);

  try {
    const answer = await $fetch<MeshGenerateResponse>(`/api/arms/${encodeURIComponent(arm.value.id)}/mesh`, {
      method: 'POST',
      body,
    });
    results.value = answer.media;
    report.value = answer.report;
    shown.value = answer.media[0] ?? null;
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

      <UiField label="Preset">
        <div class="flex flex-wrap gap-2">
          <UiButton
            v-for="preset in presets"
            :key="preset.name"
            size="sm"
            :active="activePreset === preset.name"
            :title="preset.hint"
            :data-testid="`preset-${preset.name}`"
            @click="applyPreset(preset)"
          >
            {{ preset.name }}
          </UiButton>
        </div>
        <template #hint>
          {{ presets.find((preset) => preset.name === activePreset)?.hint ?? 'Custom — the fields below.' }}
        </template>
      </UiField>

      <fieldset v-if="engine === 'trellis2'" class="space-y-3">
        <legend class="text-sm font-medium text-slate-200">Shape and texture</legend>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Shape resolution" for="shape-res">
            <UiSelect id="shape-res" v-model="shapeResolution" :options="SHAPE_RESOLUTIONS" />
          </UiField>
          <UiField label="Texture size" for="tex-size">
            <UiSelect id="tex-size" v-model="textureSize" :options="TEXTURE_SIZES" />
          </UiField>
        </div>
        <UiCheckbox
          v-model="bakeNormals"
          label="Bake a normal map"
          hint="From the dense remesh onto the decimated mesh: the detail decimation removed comes back as shading, at no cost in faces."
        />
        <UiCheckbox
          v-model="bakeOcclusion"
          label="Bake ambient occlusion"
          hint="Darkens creases and contact points. Read by three.js as the aoMap; costs a few seconds per mesh."
        />
        <UiField label="Texture quality" for="tex-quality">
          <div class="flex items-center gap-3">
            <input
              id="tex-quality"
              v-model.number="textureQuality"
              type="range"
              min="1"
              max="100"
              step="1"
              class="min-w-0 flex-1 accent-indigo-500"
              data-testid="texture-quality"
            />
            <span class="w-28 shrink-0 text-right font-mono text-xs text-slate-300">{{ qualityLabel }}</span>
          </div>
          <template #hint>
            The baked maps are re-encoded as WebP, which three.js reads natively. 100% keeps every pixel;
            lower trades detail for size — {{ qualityHint }}, scaled by the texture size above. The normal map
            gets a few points more than the rest.
          </template>
        </UiField>

        <UiField label="Decimate to (faces)" for="faces-t">
          <UiNumberInput id="faces-t" v-model="targetFaces" :min="1000" :max="2000000" :step="1000" />
          <div class="mt-2 flex flex-wrap gap-1.5">
            <UiButton
              v-for="count in FACE_PRESETS"
              :key="count"
              size="sm"
              :active="targetFaces === count"
              @click="targetFaces = count"
            >
              {{ formatCount(count) }}
            </UiButton>
          </div>
          <template #hint>
            The texture is baked onto this mesh, so it is never raw. The template uses 700K; 30–150K is
            comfortable for three.js.
          </template>
        </UiField>
      </fieldset>

      <fieldset v-if="engine === 'trellis2'" class="space-y-3 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">Sampling</legend>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Structure steps" for="st-steps">
            <UiNumberInput id="st-steps" v-model="structureSteps" :min="1" :max="100" />
          </UiField>
          <UiField label="Shape steps" for="sh-steps">
            <UiNumberInput id="sh-steps" v-model="shapeSteps" :min="1" :max="100" />
          </UiField>
          <UiField label="Refine steps" for="rf-steps">
            <UiNumberInput id="rf-steps" v-model="refineSteps" :min="1" :max="100" />
          </UiField>
          <UiField label="Texture steps" for="tx-steps">
            <UiNumberInput id="tx-steps" v-model="textureSteps" :min="1" :max="100" />
          </UiField>
          <UiField label="CFG scale" for="cfg-t">
            <UiNumberInput id="cfg-t" v-model="cfgScale" :min="0" :max="30" :step="0.5" />
          </UiField>
          <UiField label="Seed" for="seed-t">
            <UiInput id="seed-t" v-model="seed" placeholder="empty = random" />
          </UiField>
        </div>
        <p class="text-xs text-slate-500">
          Occupancy, then the shape at 512, then refined at the resolution above, then the texture on that
          shape. Guidance applies to the first two thirds of each shape pass; the texture pass is unguided,
          as in Microsoft's pipeline.
        </p>
      </fieldset>

      <fieldset v-if="engine === 'hunyuan3d-paint'" class="space-y-3">
        <legend class="text-sm font-medium text-slate-200">Shape</legend>
        <div class="grid grid-cols-2 gap-3">
          <UiField label="Octree" for="octree-p">
            <UiSelect id="octree-p" v-model="octree" :options="OCTREES" />
          </UiField>
          <UiField label="Steps" for="steps-p">
            <UiNumberInput id="steps-p" v-model="steps" :min="1" :max="100" />
          </UiField>
          <UiField label="CFG scale" for="cfg-p">
            <UiNumberInput id="cfg-p" v-model="cfgScale" :min="0" :max="30" :step="0.5" />
          </UiField>
          <UiField label="Seed" for="seed-p">
            <UiInput id="seed-p" v-model="seed" placeholder="empty = random" />
          </UiField>
        </div>
        <UiField label="Decimate to (faces)" for="faces-p">
          <UiNumberInput id="faces-p" v-model="targetFaces" :min="5000" :max="300000" :step="1000" />
          <div class="mt-2 flex flex-wrap gap-1.5">
            <UiButton
              v-for="count in FACE_PRESETS"
              :key="count"
              size="sm"
              :active="targetFaces === count"
              @click="targetFaces = count"
            >
              {{ formatCount(count) }}
            </UiButton>
          </div>
          <template #hint>
            The texture is painted onto this mesh. Tencent uses 40K; more faces mostly cost UV-unwrap time.
          </template>
        </UiField>
      </fieldset>

      <fieldset v-if="engine === 'hunyuan3d-paint'" class="space-y-3 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">Paint</legend>
        <UiCheckbox
          v-model="paintTexture"
          label="Paint a texture"
          hint="Off gives the bare shape, as the ComfyUI arm does, without loading the paint models."
        />
        <template v-if="paintTexture">
          <div class="grid grid-cols-2 gap-3">
            <UiField label="Views" for="paint-views">
              <UiSelect id="paint-views" v-model="paintViews" :options="PAINT_VIEWS" />
            </UiField>
            <UiField label="View size" for="paint-res">
              <UiSelect id="paint-res" v-model="paintResolution" :options="PAINT_RESOLUTIONS" />
            </UiField>
            <UiField label="Paint steps" for="paint-steps">
              <UiNumberInput id="paint-steps" v-model="paintSteps" :min="1" :max="50" />
            </UiField>
            <UiField label="Paint CFG" for="paint-cfg">
              <UiNumberInput id="paint-cfg" v-model="paintGuidance" :min="1" :max="10" :step="0.5" />
            </UiField>
            <UiField label="Texture size" for="tex-size-p">
              <UiSelect id="tex-size-p" v-model="textureSize" :options="PAINT_TEXTURE_SIZES" />
            </UiField>
          </div>
          <UiCheckbox
            v-model="upscale"
            label="Upscale views first"
            hint="Real-ESRGAN x4 on every painted view before it is baked — sharper texels for about a second per view."
          />
          <UiField label="Texture quality" for="tex-quality-p">
            <div class="flex items-center gap-3">
              <input
                id="tex-quality-p"
                v-model.number="textureQuality"
                type="range"
                min="1"
                max="100"
                step="1"
                class="min-w-0 flex-1 accent-indigo-500"
                data-testid="texture-quality-p"
              />
              <span class="w-28 shrink-0 text-right font-mono text-xs text-slate-300">{{ qualityLabel }}</span>
            </div>
            <template #hint>
              Base colour and metallic-roughness are re-encoded as WebP, which three.js reads natively. 100%
              keeps every pixel; lower trades detail for size.
            </template>
          </UiField>
        </template>
      </fieldset>

      <fieldset v-if="engine === 'trellis2'" class="space-y-2 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">How the weights are placed</legend>
        <UiField label="Transformer" for="transformer">
          <UiSelect id="transformer" v-model="transformer" :options="TRANSFORMERS" />
        </UiField>
        <UiField label="VRAM strategy" for="vram-mode">
          <UiSelect id="vram-mode" v-model="vramMode" :options="VRAM_MODES" />
        </UiField>
        <p class="text-xs text-slate-500">Start parameters: changing either restarts ComfyUI.</p>
      </fieldset>
    </aside>

    <div class="grid min-w-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_30rem]">
      <main class="min-w-0 space-y-6 p-6">
        <div class="flex flex-wrap items-start gap-6">
          <UiField label="Photograph of the object">
            <div class="space-y-1">
              <button
                type="button"
                class="h-44 w-44 overflow-hidden rounded-lg border border-dashed border-white/20 text-xs text-slate-500 transition-colors hover:border-white/40 hover:text-slate-300"
                data-testid="reference"
                @click="picking = true"
              >
                <MediaThumb v-if="reference" :item="reference" fit="contain" />
                <span v-else>+ Add a photo</span>
              </button>
              <button
                v-if="referenceId"
                type="button"
                class="block w-44 text-center text-[10px] text-slate-500 hover:text-rose-300"
                @click="referenceId = null"
              >
                remove
              </button>
            </div>
          </UiField>

          <div class="min-w-0 flex-1 space-y-2 text-xs text-slate-500">
            <p class="text-sm text-slate-300">What makes a photo work</p>
            <ul class="list-disc space-y-1 pl-4">
              <li>One object, whole, nothing cropped by the frame.</li>
              <li>A three-quarter view shows more of the shape than a straight-on one.</li>
              <li>Even light: a hard shadow is read as geometry.</li>
              <li>A product shot on plain background is ideal; a busy one is cut out below.</li>
            </ul>
            <p v-if="engine === 'trellis2'">
              TRELLIS.2 bakes base colour, metallic and roughness maps — plus normals and occlusion if asked —
              into the GLB, which three.js reads as a MeshStandardMaterial with no code of your own.
            </p>
            <p v-else>
              Hunyuan3D 2.1 makes the shape, then its paint model draws albedo and metallic-roughness for six
              or more views of it, baked into the GLB as a MeshStandardMaterial. The far side is drawn by the
              model, guided by the photo.
            </p>
          </div>
        </div>

        <UiCheckbox
          v-model="removeBackground"
          label="Cut the object out first"
          :hint="
            engine === 'trellis2'
              ? 'BiRefNet masks the object and crops it edge to edge on black, which is what TRELLIS.2 is conditioned on. Off, the image\'s own alpha channel is the mask — for a PNG that is already cut out.'
              : 'rembg with BiRefNet masks the object, and Hunyuan3D recentres it with a 15% margin. Off, the image\'s own alpha channel is used — for a PNG that is already cut out.'
          "
        />

        <UiField label="Note" for="note">
          <UiInput id="note" v-model="note" placeholder="What this is — kept in the library to find it again" />
          <template #hint>Not sent to the model: both engines are conditioned on the image alone.</template>
        </UiField>

        <UiField label="Batch">
          <div class="flex flex-wrap items-center gap-2">
            <UiButton
              v-for="preset in BATCH_PRESETS"
              :key="preset"
              size="sm"
              :active="batch === preset"
              @click="batch = preset"
            >
              {{ preset }}
            </UiButton>
            <div class="w-24"><UiNumberInput v-model="batch" :min="1" :max="MAX_BATCH" /></div>
          </div>
          <template #hint>
            One seed per mesh, filed separately. The cut-out and the image encode are cached across a batch,
            so later seeds only pay for sampling and the decode.
          </template>
        </UiField>

        <div class="flex flex-wrap items-center gap-3">
          <UiButton variant="primary" :disabled="!canGenerate" data-testid="generate" @click="generate">
            {{ status === 'generating' ? 'Running…' : 'Generate 3D model' }}
          </UiButton>
          <UiButton v-if="job && status === 'generating'" @click="stopWatching()">Stop watching</UiButton>
          <NuxtLink to="/library" class="ml-auto">
            <UiButton>Library →</UiButton>
          </NuxtLink>
        </div>

        <UiAlert v-if="failure" tone="error">{{ failure }}</UiAlert>

        <section v-if="shown" class="space-y-3">
          <div class="h-[28rem] overflow-hidden rounded-lg border border-white/10">
            <ModelViewer :key="shown.id" :src="mediaUrl(shown.id)" :bytes="shown.bytes" />
          </div>

          <ul v-if="results.length > 1" class="flex flex-wrap gap-2">
            <li v-for="item in results" :key="item.id">
              <UiButton size="sm" :active="shown.id === item.id" @click="shown = item">
                seed {{ item.meta?.settings?.seed }}
              </UiButton>
            </li>
          </ul>

          <div v-if="report" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{{ report.seconds_total.toFixed(1) }} s</span>
            <span>{{ report.meshes.length }} mesh{{ report.meshes.length === 1 ? '' : 'es' }}</span>
            <span>{{ formatBytes(report.meshes.reduce((sum, one) => sum + one.out_bytes, 0)) }}</span>
            <span v-if="report.meshes[0]?.faces">{{ formatCount(report.meshes[0].faces) }} faces</span>
            <span v-if="report.meshes[0]?.textured">textured</span>
            <span v-if="report.meshes[0]?.texture_bytes_before">
              maps {{ formatBytes(report.meshes[0].texture_bytes_before) }} →
              {{ formatBytes(report.meshes[0].texture_bytes_after ?? 0) }}
            </span>
            <span :title="VRAM_SCOPE[report.vram_scope]">
              peak {{ report.peak_vram_gib.toFixed(2) }} GiB
              <span v-if="report.vram_scope !== 'process'" class="text-slate-500">
                ({{ report.vram_scope === 'card' ? 'whole card' : 'unmeasured' }})
              </span>
            </span>
            <a :href="mediaUrl(shown.id)" :download="shown.name" class="text-indigo-300 hover:text-indigo-200">
              Download GLB
            </a>
            <NuxtLink
              :to="{ path: '/library', query: { folder: shown.group, item: shown.id } }"
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
            No arm has to be started first. The supervisor stops whatever holds the card and loads what this
            job needs.
          </p>
          <p class="text-xs">
            <template v-if="engine === 'trellis2'">
              A run is the cut-out, the DINOv3 encode, four sampling passes, then the remesh, decimation, UV
              unwrap and bakes — those last steps are CPU-heavy and take a good share of the time.
            </template>
            <template v-else>
              A run is the cut-out, the shape sampler and surface extraction, a UV unwrap, then the paint
              model on six or more views, an upscale, and the bake back onto the UV map. The first run also
              loads every model, about 16 GB from disk.
            </template>
          </p>
        </div>
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
