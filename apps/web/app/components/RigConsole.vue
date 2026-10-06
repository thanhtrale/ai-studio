<script setup lang="ts">
/**
 * The rig console: a humanoid mesh from the library in, the same mesh with a
 * Mixamo skeleton, skin weights and clips out -- a GLB three.js plays with an
 * `AnimationMixer`.
 *
 * The same three columns as the other consoles. What it asks for is small:
 * which clips, and two choices about the skeleton. Everything that matters
 * more -- whether the mesh is in an A- or T-pose, whether the arms are clear
 * of the body -- was decided when the mesh was made, which is why the hints
 * here point back at that.
 */
import { computed, ref, watch } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type { ArmRigReport, RigGenerateRequest, RigGenerateResponse } from '#shared/generate';
import {
  formatBytes,
  formatCount,
  isRigSettings,
  type MediaItem,
  type MediaMeta,
  type RigJobSettings,
} from '#shared/library';

import { restoreKey } from '../utils/restore';
import JobTimeline from './JobTimeline.vue';
import MediaPicker from './MediaPicker.vue';
import ModelViewer from './ModelViewer.vue';
import VramChart from './VramChart.vue';
import UiAlert from './ui/Alert.vue';
import UiButton from './ui/Button.vue';
import UiCheckbox from './ui/Checkbox.vue';
import UiField from './ui/Field.vue';
import UiInput from './ui/Input.vue';
import UiSelect from './ui/Select.vue';

const props = defineProps<{
  arms: ArmSummary[];
  restore?: MediaMeta | null;
  /** The mesh to start from, from `?mesh=` on the page. */
  initialMesh?: string | null;
}>();

interface ClipOption {
  name: string;
  source: 'builtin' | 'mixamo';
}

const rigArms = computed(() => props.arms.filter((arm) => arm.capabilities.includes('mesh.rig')));
const armId = ref('');
watch(
  rigArms,
  (list) => {
    if (!armId.value && list[0]) armId.value = list[0].id;
  },
  { immediate: true },
);
const armOptions = computed(() => rigArms.value.map((arm) => ({ value: arm.id, label: arm.name })));
const arm = computed(() => rigArms.value.find((candidate) => candidate.id === armId.value) ?? null);

const { data: clipData, refresh: refreshClips } = useFetch<{ clips: ClipOption[]; folder: string }>(
  '/api/rig/clips',
  { default: () => ({ clips: [], folder: 'models/mixamo-clips' }) },
);
const clipOptions = computed(() => clipData.value?.clips ?? []);
const chosen = ref<string[]>([]);
let clipsSeeded = false;
watch(
  clipOptions,
  (options) => {
    // Every clip on by default: a rig with nothing to play is a harder thing
    // to judge than one with a clip too many.
    if (!clipsSeeded && options.length) {
      chosen.value = options.map((option) => option.name);
      clipsSeeded = true;
    }
  },
  { immediate: true },
);

function toggle(name: string, on: boolean): void {
  chosen.value = on ? [...new Set([...chosen.value, name])] : chosen.value.filter((one) => one !== name);
}

const removeFingers = ref(true);
const inPlace = ref(true);
const textureQuality = ref(100);
const note = ref('');

const meshId = ref<string | null>(null);
const picking = ref(false);
const { byId, refresh: refreshMedia } = useMedia();
const mesh = computed(() => (meshId.value ? (byId.value.get(meshId.value) ?? null) : null));

let restored: string | null = null;
watch(
  () => props.restore,
  (meta) => {
    if (!meta) return;
    const key = restoreKey(meta);
    if (key === restored) return;
    restored = key;
    note.value = meta.prompt ?? '';
    meshId.value = meta.referenceId ?? null;
    if (!isRigSettings(meta.settings)) return;
    chosen.value = [...meta.settings.clips];
    clipsSeeded = true;
    removeFingers.value = meta.settings.removeFingers;
    inPlace.value = meta.settings.inPlace;
    textureQuality.value = meta.settings.textureQuality;
  },
  { immediate: true },
);
watch(
  () => props.initialMesh,
  (id) => {
    if (id) meshId.value = id;
  },
  { immediate: true },
);

const status = ref<'idle' | 'running'>('idle');
const failure = ref<string | null>(null);
const result = ref<MediaItem | null>(null);
const report = ref<ArmRigReport | null>(null);

const { job, machine, armVram, capacityGib, available, elapsedSeconds, watch: follow, stopWatching } =
  useJobTelemetry();

const canRun = computed(() => meshId.value !== null && arm.value !== null && status.value === 'idle');

async function run(): Promise<void> {
  if (!canRun.value || !arm.value || !meshId.value) return;
  status.value = 'running';
  failure.value = null;
  result.value = null;
  report.value = null;

  const settings: RigJobSettings = {
    kind: 'rig',
    // In the order offered, whatever order they were ticked in.
    clips: clipOptions.value.map((option) => option.name).filter((name) => chosen.value.includes(name)),
    removeFingers: removeFingers.value,
    inPlace: inPlace.value,
    compressTextures: true,
    textureQuality: textureQuality.value,
    seed: 0,
    batch: 1,
    batchIndex: 0,
  };
  const jobId = crypto.randomUUID();
  const body: RigGenerateRequest = {
    jobId,
    meshId: meshId.value,
    settings,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
  };
  follow(jobId);
  try {
    const answer = await $fetch<RigGenerateResponse>(`/api/arms/${encodeURIComponent(arm.value.id)}/rig`, {
      method: 'POST',
      body,
    });
    result.value = answer.media[0] ?? null;
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
      <UiField label="Arm" for="rig-arm">
        <UiSelect id="rig-arm" v-model="armId" :options="armOptions" />
        <template #hint>
          <span v-if="arm">Make-It-Animatable v2 · Mixamo skeleton · Blender bind and export</span>
          <span v-else>No arm declares mesh.rig. Check capabilities in a manifest under arms/.</span>
        </template>
      </UiField>

      <fieldset class="space-y-2">
        <legend class="flex w-full items-center justify-between text-sm font-medium text-slate-200">
          <span>Clips</span>
          <button
            type="button"
            class="text-xs font-normal text-slate-500 hover:text-slate-300"
            @click="refreshClips()"
          >
            reload
          </button>
        </legend>
        <div class="space-y-1.5" data-testid="clip-list">
          <label
            v-for="option in clipOptions"
            :key="option.name"
            class="flex items-center gap-2 text-sm text-slate-300"
          >
            <input
              type="checkbox"
              class="accent-indigo-500"
              :checked="chosen.includes(option.name)"
              @change="toggle(option.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="flex-1">{{ option.name }}</span>
            <span class="text-[10px] uppercase tracking-wide text-slate-500">{{ option.source }}</span>
          </label>
        </div>
        <p class="text-xs text-slate-500">
          Built-in clips are keyframed on the rig itself. For more, download any clip from Mixamo for
          <span class="text-slate-400">X Bot</span>, as FBX without skin, and drop it in
          <code class="text-slate-400">storage/{{ clipData?.folder }}</code>; the file name becomes the clip's
          name.
        </p>
      </fieldset>

      <fieldset class="space-y-3 border-t border-white/10 pt-4">
        <legend class="text-sm font-medium text-slate-200">Skeleton</legend>
        <UiCheckbox
          v-model="removeFingers"
          label="Fold fingers into the hands"
          hint="A generated mesh's fingers are usually one lump; finger bones would only smear it. Off keeps all 52 Mixamo bones."
        />
        <UiCheckbox
          v-model="inPlace"
          label="Clips in place"
          hint="Run and walk cycles stay on the spot, which is what a page that moves the character itself wants."
        />
        <UiField label="Texture quality" for="rig-quality">
          <div class="flex items-center gap-3">
            <input
              id="rig-quality"
              v-model.number="textureQuality"
              type="range"
              min="1"
              max="100"
              step="1"
              class="min-w-0 flex-1 accent-indigo-500"
            />
            <span class="w-28 shrink-0 text-right font-mono text-xs text-slate-300">
              {{ textureQuality >= 100 ? '100% · lossless' : `${textureQuality}% · lossy` }}
            </span>
          </div>
          <template #hint>The mesh's maps are re-encoded as WebP after Blender writes the GLB.</template>
        </UiField>
      </fieldset>
    </aside>

    <div class="grid min-w-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_30rem]">
      <main class="min-w-0 space-y-6 p-6">
        <div class="flex flex-wrap items-start gap-6">
          <UiField label="Mesh to rig">
            <div class="space-y-1">
              <button
                type="button"
                class="h-44 w-44 overflow-hidden rounded-lg border border-dashed border-white/20 text-xs text-slate-500 transition-colors hover:border-white/40 hover:text-slate-300"
                data-testid="mesh"
                @click="picking = true"
              >
                <ModelViewer v-if="mesh" :key="mesh.id" :src="mediaUrl(mesh.id)" compact />
                <span v-else>+ Pick a mesh</span>
              </button>
              <p v-if="mesh" class="w-44 truncate text-center text-[10px] text-slate-500">{{ mesh.name }}</p>
            </div>
          </UiField>

          <div class="min-w-0 flex-1 space-y-2 text-xs text-slate-500">
            <p class="text-sm text-slate-300">What makes a mesh rig well</p>
            <ul class="list-disc space-y-1 pl-4">
              <li>A humanoid in an A- or T-pose, arms clear of the body, legs apart.</li>
              <li>Made from a front-on photo of exactly that: ask the image model for "A-pose, full body".</li>
              <li>Fitted clothes. A long robe or cape is skinned to the legs and swings with them.</li>
              <li>Nothing held: a sword or a bag is skinned to the hand as if it were part of it.</li>
            </ul>
          </div>
        </div>

        <UiField label="Note" for="rig-note">
          <UiInput id="rig-note" v-model="note" placeholder="What this is — kept in the library to find it again" />
        </UiField>

        <div class="flex flex-wrap items-center gap-3">
          <UiButton variant="primary" :disabled="!canRun" data-testid="rig" @click="run">
            {{ status === 'running' ? 'Rigging…' : 'Rig & animate' }}
          </UiButton>
          <UiButton v-if="job && status === 'running'" @click="stopWatching()">Stop watching</UiButton>
          <NuxtLink to="/library" class="ml-auto"><UiButton>Library →</UiButton></NuxtLink>
        </div>

        <UiAlert v-if="failure" tone="error">{{ failure }}</UiAlert>

        <section v-if="result" class="space-y-3">
          <div class="h-[28rem] overflow-hidden rounded-lg border border-white/10">
            <ModelViewer :key="result.id" :src="mediaUrl(result.id)" :bytes="result.bytes" :auto-rotate="false" />
          </div>
          <div v-if="report" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{{ report.seconds_total.toFixed(1) }} s</span>
            <span>{{ report.bones }} bones</span>
            <span>{{ report.clips.length }} clip{{ report.clips.length === 1 ? '' : 's' }}</span>
            <span>{{ formatCount(report.faces) }} faces</span>
            <span>{{ formatBytes(report.out_bytes) }}</span>
            <a :href="mediaUrl(result.id)" :download="result.name" class="text-indigo-300 hover:text-indigo-200">
              Download GLB
            </a>
            <NuxtLink
              :to="{ path: '/library', query: { folder: result.group, item: result.id } }"
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
        <p v-if="!job" class="text-xs text-slate-500">
          A rig is three small networks over 32K points of the surface — joints, weights, and the pose that
          takes the mesh to a T-pose — then Blender binds the skin, retargets the clips and writes the GLB.
          Seconds, not minutes; the first run also loads the networks.
        </p>
      </aside>
    </div>

    <MediaPicker
      :open="picking"
      kind="model"
      :selected-id="meshId"
      @close="picking = false"
      @select="(id) => (meshId = id)"
    />
  </div>
</template>
