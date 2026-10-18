<script setup lang="ts">
/**
 * One run, in full: what it was asked, how it went, its review, and every
 * output a review needs -- the sheets and their cross-check, the views Pixal3D
 * was actually shown, the turntable, clay and close-up renders, the clips with
 * their stretch and hand-in-body numbers.
 *
 * Reviews are made from the close-ups, not from the thumbnails: the faults
 * that fail a mesh (cat-slit pupils, speckles, a missing eye) do not show at
 * thumbnail size. Compare against the ORIGINAL reference, not against a
 * generic idea of a good face.
 */
import { computed, ref, watch } from 'vue';

import type { Char3dCharacter, Char3dRun, Char3dSheetSet, Char3dStep } from '#shared/char3d';
import { CHAR3D_VIEWS } from '#shared/char3d';

import JobTimeline from '../JobTimeline.vue';
import ModelViewer from '../ModelViewer.vue';
import UiAlert from '../ui/Alert.vue';
import UiBadge from '../ui/Badge.vue';
import UiButton from '../ui/Button.vue';
import UiCard from '../ui/Card.vue';
import ReviewForm from './ReviewForm.vue';

const props = defineProps<{
  charId: string;
  character: Char3dCharacter;
  runs: Char3dRun[];
  run: Char3dRun;
  inGallery: (set?: number) => boolean;
  savedForReview: boolean;
  backLabel: string;
}>();
const emit = defineEmits<{
  open: [run: string];
  back: [];
  refresh: [];
  gallery: [add: boolean, set?: number];
  saveForReview: [];
}>();

const file = (rel?: string): string => (rel ? `/api/char3d/${props.charId}/file/${rel}` : '');
const STEP_LABEL: Record<Char3dStep, string> = { ref: 'Reference', mesh: 'Mesh', rig: 'Rig' };
const VERDICT_TONE = { pass: 'ok', retry: 'warn', fail: 'bad' } as const;
const STATUS_TONE = { done: 'ok', running: 'accent', queued: 'neutral', error: 'bad', cancelled: 'neutral' } as const;
const time = (at?: number): string => (at ? new Date(at).toLocaleString() : '');
const seconds = (ms?: number): string => (ms ? `${(ms / 1000).toFixed(1)} s` : '');
const pct = (value?: number): string => (value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

const outputs = computed(() => props.run.outputs ?? {});
const config = computed(() => props.run.config as Record<string, any>);
const sheetSets = computed(() => (outputs.value['sets'] ?? []) as Char3dSheetSet[]);

/** A ref run of separate views: its images per view, in rig order. */
const refByView = computed(() => {
  const images = (outputs.value['images'] ?? []) as { view: string; file: string; seed?: number }[];
  return CHAR3D_VIEWS.map((view) => ({ view, images: images.filter((image) => image.view === view) })).filter(
    (entry) => entry.images.length,
  );
});

/** What Pixal3D was shown, in the rig's order. */
const meshViews = computed(() => {
  const views = (outputs.value['views'] ?? {}) as Record<string, string>;
  return CHAR3D_VIEWS.filter((view) => views[view]).map((view) => ({ view, file: views[view] as string }));
});

/** The generated reference views a mesh was made from -- a rig reads back through its mesh run. */
const sourceRefs = computed(() => {
  let source: Char3dRun | undefined = props.run;
  if (source.step === 'rig') {
    const meshRun = String(source.config['mesh'] ?? '').split('/')[1];
    source = props.runs.find((candidate) => candidate.id === meshRun);
  }
  if (source?.step !== 'mesh') return [];
  const views = (source.config['views'] ?? {}) as Record<string, string>;
  return CHAR3D_VIEWS.filter((view) => views[view]).map((view) => ({
    view,
    file: views[view] as string,
    run: (views[view] as string).split('/')[1] ?? '',
  }));
});

/**
 * The largest per-frame jump of the torso-clearance correction, over every
 * clip and both arms. A few degrees is the correction easing in; tens of
 * degrees is an arm twisting round in a frame or two.
 */
const torsoStepDeg = computed<number | null>(() => {
  const entries = outputs.value['rigInfo']?.torsoClear;
  if (!Array.isArray(entries)) return null;
  let worst: number | null = null;
  for (const entry of entries as Record<string, { maxStepDeg?: number } | undefined>[]) {
    for (const side of ['Left', 'Right']) {
      const step = entry?.[side]?.maxStepDeg;
      if (typeof step === 'number') worst = Math.max(worst ?? 0, step);
    }
  }
  return worst;
});

const renders = computed(() => (outputs.value['renders']?.files ?? null) as Record<string, any> | null);
const renderInfo = computed(() => (outputs.value['renders']?.info ?? null) as Record<string, any> | null);
const clipRenders = computed(() => Object.entries((renders.value?.['clips'] ?? {}) as Record<string, any>));

const showConfig = ref(false);
const reviewing = ref(false);
watch(
  () => props.run.id,
  () => {
    reviewing.value = false;
    showConfig.value = false;
  },
);

// Which file the rig viewer shows: with the clips, the rest pose alone, or the mesh that went in.
const rigModel = ref<'rigged' | 'rest' | 'input'>('rigged');
const rigSrc = computed(() => {
  if (rigModel.value === 'rest' && outputs.value['rest']) return file(outputs.value['rest']);
  if (rigModel.value === 'input' && config.value['mesh']) return file(config.value['mesh']);
  return file(outputs.value['glb']);
});

// The live run's current job, followed on the studio's own timeline.
const { job, elapsedSeconds, watch: follow, stopWatching } = useJobTelemetry();
const liveJob = computed(() =>
  props.run.status === 'running' || props.run.status === 'queued' ? (props.run.jobs?.at(-1)?.id ?? null) : null,
);
watch(
  liveJob,
  (id) => {
    if (id) follow(id);
    else stopWatching();
  },
  { immediate: true },
);
</script>

<template>
  <div class="space-y-5">
    <button type="button" class="text-sm text-slate-400 hover:text-slate-100" @click="emit('back')">
      ← {{ backLabel }}
    </button>

    <header class="flex flex-wrap items-center gap-2">
      <h2 class="font-mono text-xl font-semibold">{{ run.id }}</h2>
      <UiBadge>{{ STEP_LABEL[run.step] }}</UiBadge>
      <UiBadge :tone="STATUS_TONE[run.status]">{{ run.status }}</UiBadge>
      <span v-if="run.stage && run.status === 'running'" class="text-sm text-slate-400">{{ run.stage }}</span>
      <span class="flex-1" />
      <button v-if="run.parent" type="button" class="text-sm text-slate-400 hover:text-slate-100" @click="emit('open', run.parent!)">
        ← from {{ run.parent }}
      </button>
      <template v-if="run.status === 'done' && run.step !== 'ref'">
        <UiButton v-if="inGallery()" size="sm" title="Remove from the gallery (the run is kept)" @click="emit('gallery', false)">
          In gallery ✓
        </UiButton>
        <UiButton v-else size="sm" title="Add to the gallery so the next step can use it" @click="emit('gallery', true)">
          Add to gallery
        </UiButton>
      </template>
      <template v-if="run.step === 'rig' && run.status === 'done'">
        <NuxtLink
          v-if="savedForReview"
          :to="`/char3d/review?c=${charId}-${run.id}`"
          class="text-sm text-indigo-300 hover:text-indigo-200"
        >
          In animation review →
        </NuxtLink>
        <UiButton v-else size="sm" title="Save this rig to the animation review list" @click="emit('saveForReview')">
          Save for review
        </UiButton>
      </template>
      <UiButton size="sm" variant="ghost" title="Refresh" @click="emit('refresh')">Refresh</UiButton>
    </header>

    <p v-if="run.intent" class="text-sm text-slate-200">{{ run.intent }}</p>
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
      <span>created {{ time(run.createdAt) }}</span>
      <span v-if="config['arm']">arm <b class="text-slate-300">{{ config['arm'] }}</b></span>
      <span v-if="run.timing?.['totalMs']">total {{ seconds(run.timing['totalMs']) }}</span>
      <span v-if="run.timing?.['mesh']?.seconds">Pixal3D {{ run.timing['mesh'].seconds.toFixed(1) }} s</span>
      <span v-if="run.timing?.['mesh']?.peakVramGib">peak {{ run.timing['mesh'].peakVramGib.toFixed(2) }} GiB</span>
      <span v-if="outputs['seed'] !== undefined">seed {{ outputs['seed'] }}</span>
      <button type="button" class="hover:text-slate-200" @click="showConfig = !showConfig">
        {{ showConfig ? 'hide' : 'show' }} config
      </button>
    </div>
    <pre
      v-if="showConfig"
      class="max-h-80 overflow-auto rounded border border-white/10 bg-black/30 p-3 text-xs text-slate-300"
    >{{ JSON.stringify({ config: run.config, jobs: run.jobs, timing: run.timing }, null, 1) }}</pre>
    <UiAlert v-if="run.error" tone="error">{{ run.error }}</UiAlert>

    <UiCard v-if="liveJob">
      <div class="p-4">
        <JobTimeline :job="job" :elapsed-seconds="elapsedSeconds" />
      </div>
    </UiCard>

    <!-- review -->
    <UiCard v-if="run.review && !reviewing">
      <div class="space-y-3 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-3xl font-bold">{{ run.review.score }}<span class="text-sm text-slate-500">/100</span></span>
          <UiBadge :tone="VERDICT_TONE[run.review.verdict]">{{ run.review.verdict }}</UiBadge>
          <span class="text-xs text-slate-500">by {{ run.review.by }} · {{ time(run.review.at) }}</span>
          <span class="flex-1" />
          <UiButton size="sm" variant="ghost" @click="reviewing = true">Edit review</UiButton>
        </div>
        <p class="text-sm text-slate-200">{{ run.review.summary }}</p>
        <div v-if="run.review.criteria.length" class="space-y-1.5">
          <div v-for="criterion in run.review.criteria" :key="criterion.key" class="flex items-start gap-2 text-sm">
            <span class="w-40 shrink-0 text-slate-300">{{ criterion.label }}</span>
            <span class="mt-2 h-1.5 w-28 shrink-0 overflow-hidden rounded bg-white/10">
              <span
                class="block h-full"
                :class="criterion.score >= 8 ? 'bg-emerald-400' : criterion.score >= 5 ? 'bg-amber-400' : 'bg-rose-400'"
                :style="{ width: `${criterion.score * 10}%` }"
              />
            </span>
            <b class="w-8 shrink-0">{{ criterion.score }}</b>
            <span class="text-slate-400">{{ criterion.note }}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-6">
          <div v-if="run.review.issues.length" class="min-w-64 flex-1">
            <p class="text-sm font-medium text-rose-300">Issues</p>
            <ul class="mt-1 list-disc pl-5 text-sm text-slate-300">
              <li v-for="(issue, index) in run.review.issues" :key="index">{{ issue }}</li>
            </ul>
          </div>
          <div v-if="run.review.improve.length" class="min-w-64 flex-1">
            <p class="text-sm font-medium text-indigo-300">To improve</p>
            <ul class="mt-1 list-disc pl-5 text-sm text-slate-300">
              <li v-for="(item, index) in run.review.improve" :key="index">{{ item }}</li>
            </ul>
          </div>
        </div>
        <p v-if="run.review.next" class="text-sm"><b>Next:</b> {{ run.review.next }}</p>
      </div>
    </UiCard>
    <UiCard v-else-if="run.status === 'done'">
      <div class="space-y-3 p-4">
        <div class="flex items-center gap-2">
          <p class="flex-1 text-sm font-medium">{{ run.review ? 'Edit the review' : 'Not reviewed yet' }}</p>
          <UiButton v-if="run.review" size="sm" variant="ghost" @click="reviewing = false">Cancel</UiButton>
        </div>
        <ReviewForm :char-id="charId" :run-id="run.id" :review="run.review" @saved="reviewing = false; emit('refresh')" />
      </div>
    </UiCard>

    <!-- ref: sheets -->
    <section v-if="run.step === 'ref' && sheetSets.length" class="space-y-4">
      <UiCard v-for="set in sheetSets" :key="set.index">
        <div class="space-y-2 p-3">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <b>Sheet {{ set.index }}</b>
            <span class="text-xs text-slate-500">seed {{ set.seed }}</span>
            <UiBadge
              v-if="set.views"
              :tone="set.check.ok ? 'ok' : 'warn'"
              title="Width front vs back within 5%, height of the three views within 3%"
            >
              width {{ pct(set.check.widthDiff) }} · height {{ pct(set.check.heightDiff) }}
            </UiBadge>
            <UiBadge v-else tone="bad">{{ set.check.segments }} figures — cannot split</UiBadge>
            <span class="flex-1" />
            <template v-if="set.views && run.status === 'done'">
              <UiButton v-if="inGallery(set.index)" size="sm" @click="emit('gallery', false, set.index)">In gallery ✓</UiButton>
              <UiButton v-else size="sm" title="Add to the gallery so the mesh step can use it" @click="emit('gallery', true, set.index)">
                Add to gallery
              </UiButton>
            </template>
          </div>
          <a :href="file(set.sheet)" target="_blank">
            <img :src="file(set.sheet)" alt="" class="w-full rounded border border-white/10 bg-white" />
          </a>
          <div v-if="set.views" class="flex gap-2">
            <img
              v-for="view in ['front', 'left', 'back'] as const"
              :key="view"
              :src="file(set.views[view])"
              :alt="view"
              class="h-40 rounded bg-white object-contain"
            />
          </div>
        </div>
      </UiCard>
      <details class="text-xs text-slate-400">
        <summary class="cursor-pointer">prompt</summary>
        <p class="mt-1 whitespace-pre-wrap">{{ config['prompts']?.sheet }}</p>
      </details>
    </section>

    <!-- ref: separate views -->
    <section v-else-if="run.step === 'ref' && run.outputs" class="space-y-4">
      <div v-for="entry in refByView" :key="entry.view" class="space-y-2">
        <p class="text-sm font-medium capitalize">{{ entry.view }}</p>
        <div class="flex flex-wrap gap-2">
          <img :src="file(character.ref)" alt="" class="h-64 rounded border border-dashed border-white/20 bg-white object-contain opacity-70" title="Original reference" />
          <a v-for="image in entry.images" :key="image.file" :href="file(image.file)" target="_blank" class="space-y-1 text-center">
            <img :src="file(image.file)" alt="" class="h-64 rounded border border-white/10 bg-white object-contain" />
            <span class="block text-xs text-slate-500">{{ image.file.split('/').pop() }} · seed {{ image.seed }}</span>
          </a>
        </div>
        <details class="text-xs text-slate-400">
          <summary class="cursor-pointer">prompt</summary>
          <p class="mt-1 whitespace-pre-wrap">{{ config['prompts']?.[entry.view] }}</p>
        </details>
      </div>
    </section>

    <!-- mesh -->
    <section v-if="run.step === 'mesh' && outputs['glb']" class="space-y-4">
      <div class="flex flex-wrap gap-4">
        <div class="h-[520px] min-w-80 flex-[3]">
          <ModelViewer :src="file(outputs['glb'])" :bytes="outputs['bytes']" />
        </div>
        <div class="min-w-56 flex-1 space-y-2 text-sm">
          <p class="font-medium" title="Background removed; Pixal3D is given the cut-out on black">Views Pixal3D was shown</p>
          <div class="flex flex-wrap gap-2">
            <a v-for="view in meshViews" :key="view.view" :href="file(view.file)" target="_blank" class="text-center">
              <img :src="file(view.file)" alt="" class="size-24 rounded border border-white/10 bg-black object-contain" />
              <span class="text-xs text-slate-500">{{ view.view }}</span>
            </a>
          </div>
          <p class="font-medium">Original reference</p>
          <img :src="file(character.ref)" alt="" class="h-40 rounded border border-white/10 bg-white object-contain" />
          <p v-if="renderInfo" class="text-xs text-slate-500">
            {{ renderInfo['faces']?.toLocaleString() }} faces · {{ renderInfo['verts']?.toLocaleString() }} verts ·
            w/h {{ renderInfo['aspect']?.widthOverHeight?.toFixed(2) }} · d/h {{ renderInfo['aspect']?.depthOverHeight?.toFixed(2) }}
          </p>
          <p v-if="outputs['reproject']?.views" class="text-xs text-slate-500">
            colours re-projected from the input views<template v-if="config['retexture']"> · geometry of {{ config['retexture'] }}</template>
          </p>
          <p v-if="outputs['reproject']?.error" class="text-xs text-amber-300">re-projection failed: {{ outputs['reproject'].error }}</p>
          <a :href="file(outputs['glb'])" download class="block text-indigo-300 hover:text-indigo-200">
            mesh.glb ({{ ((outputs['bytes'] ?? 0) / 2 ** 20).toFixed(1) }} MiB)
          </a>
        </div>
      </div>
      <template v-if="sourceRefs.length">
        <p class="text-sm font-medium">Generated reference views used</p>
        <div class="flex flex-wrap gap-2">
          <div v-for="source in sourceRefs" :key="source.view" class="space-y-1 text-center">
            <a :href="file(source.file)" target="_blank"><img :src="file(source.file)" alt="" class="h-72 rounded border border-white/10 bg-white object-contain" /></a>
            <button type="button" class="text-xs text-slate-500 hover:text-slate-200" @click="emit('open', source.run)">
              {{ source.view }} · {{ source.run }}
            </button>
          </div>
        </div>
      </template>
      <template v-if="renders">
        <p class="text-sm font-medium">Turntable — texture</p>
        <img :src="file(renders['sheet_tex'])" alt="" class="w-full rounded border border-white/10" />
        <p class="text-sm font-medium">Clay — geometry only</p>
        <img :src="file(renders['sheet_clay'])" alt="" class="w-full rounded border border-white/10" />
        <template v-if="renders['sheet_detail']">
          <p class="text-sm font-medium">Detail — eyes and brows, hair tie, inside the sleeves</p>
          <img :src="file(renders['sheet_detail'])" alt="" class="w-full rounded border border-white/10" />
        </template>
        <div class="flex flex-wrap gap-4">
          <div class="space-y-1"><p class="text-sm font-medium">Face</p><img :src="file(renders['face_front'])" alt="" class="h-56 rounded border border-white/10" /></div>
          <div class="space-y-1"><p class="text-sm font-medium">Face 3/4</p><img :src="file(renders['face_34'])" alt="" class="h-56 rounded border border-white/10" /></div>
          <div v-if="outputs['basecolor']" class="space-y-1">
            <p class="text-sm font-medium">Base colour atlas</p>
            <img :src="file(outputs['basecolor'])" alt="" class="h-56 rounded border border-white/10 bg-black" />
          </div>
        </div>
      </template>
    </section>

    <!-- rig -->
    <section v-if="run.step === 'rig' && outputs['glb']" class="space-y-4">
      <div class="flex flex-wrap gap-4">
        <div class="min-w-80 flex-[3] space-y-2">
          <div class="h-[560px]"><ModelViewer :src="rigSrc" /></div>
          <div class="flex gap-1">
            <UiButton
              v-for="mode in ['rigged', 'rest', 'input'] as const"
              :key="mode"
              size="sm"
              :active="rigModel === mode"
              @click="rigModel = mode"
            >
              {{ mode === 'rigged' ? 'Animated' : mode === 'rest' ? 'Rest pose' : 'Input mesh' }}
            </UiButton>
          </div>
          <p class="text-xs text-slate-500">
            The rigged GLB drops Pixal3D's occlusion map: it was baked for the rest pose and turns the inside of a
            sleeve black once the arm moves. Check here as well as in the renders below — Workbench does not draw it.
          </p>
        </div>
        <div class="min-w-56 flex-1 space-y-2 text-sm">
          <p>{{ outputs['bones'] }} bones (mixamorig)</p>
          <template v-if="outputs['rigInfo']">
            <p class="text-xs text-slate-500">
              rest pose {{ outputs['rigInfo'].restPose ?? 'none' }} · canonical {{ outputs['rigInfo'].canonical ? 'on' : 'off' }}
            </p>
            <p v-if="outputs['rigInfo'].headShrink" class="text-xs text-slate-500">
              head shrink: head {{ Math.round(outputs['rigInfo'].headShrink.headRatio * 100) }}% of height →
              ×{{ outputs['rigInfo'].headShrink.scale }} {{ outputs['rigInfo'].headShrink.applied ? '' : '(not applied)' }}
            </p>
          </template>
          <p
            v-if="torsoStepDeg !== null"
            class="text-xs"
            :class="torsoStepDeg > 20 ? 'text-rose-300' : 'text-slate-500'"
            title="Largest per-frame jump of the torso-clearance correction. Tens of degrees means an arm twisting round."
          >
            torso clearance: largest step {{ torsoStepDeg.toFixed(1) }}°/frame
          </p>
          <p v-if="outputs['clipsMissing']?.length" class="text-xs text-amber-300">
            clips not on disk, left out: {{ outputs['clipsMissing'].join(', ') }}
          </p>
          <p v-for="clip in outputs['clips'] ?? []" :key="clip.name" class="text-xs text-slate-500">
            clip <b class="text-slate-300">{{ clip.name }}</b> · frames {{ clip.frames?.join('–') }}
          </p>
          <a :href="file(outputs['glb'])" download class="block text-indigo-300 hover:text-indigo-200">rigged.glb</a>
          <a v-if="outputs['fbx']" :href="file(outputs['fbx'])" class="block text-indigo-300 hover:text-indigo-200">rigged.fbx</a>
          <p class="font-medium">Original reference</p>
          <img :src="file(character.ref)" alt="" class="h-40 rounded border border-white/10 bg-white object-contain" />
        </div>
      </div>
      <template v-if="sourceRefs.length">
        <p class="text-sm font-medium">Generated reference views used (via {{ String(config['mesh'] ?? '').split('/')[1] }})</p>
        <div class="flex flex-wrap gap-2">
          <div v-for="source in sourceRefs" :key="source.view" class="space-y-1 text-center">
            <a :href="file(source.file)" target="_blank"><img :src="file(source.file)" alt="" class="h-56 rounded border border-white/10 bg-white object-contain" /></a>
            <button type="button" class="text-xs text-slate-500 hover:text-slate-200" @click="emit('open', source.run)">
              {{ source.view }} · {{ source.run }}
            </button>
          </div>
        </div>
      </template>
      <template v-if="renders">
        <p class="text-sm font-medium">Rest pose and skeleton</p>
        <img :src="file(renders['rest_bones'])" alt="" class="max-h-96 rounded border border-white/10" />
        <div v-for="[name, clip] in clipRenders" :key="name" class="space-y-1">
          <p class="text-sm font-medium">
            {{ String(name).replace(/_Armature$/, '') }} — frames {{ clip.range?.join('–') }}
            <span
              v-if="clip.stretchWorst"
              class="font-normal text-slate-400"
              title="Edge length against the rest pose over the sampled frames; edges under half the median are ignored. A visible pulled strip is p99 above ~2.5 or more than ~2% of edges over 2×."
            >
              · stretch p99 {{ clip.stretchWorst.p99 }} · max {{ clip.stretchWorst.max }} ·
              {{ (clip.stretchWorst.over2 * 100).toFixed(1) }}% edges &gt;2×
            </span>
            <span
              v-if="clip.handInBody?.of"
              :class="clip.handInBody.frames ? 'text-rose-300' : 'text-emerald-300'"
              title="Frames (of 30 sampled) where 5% or more of a hand's vertices are inside the torso. Anything but 0 is a hand sinking into the body."
            >
              · hand in body {{ clip.handInBody.frames }}/{{ clip.handInBody.of }}
              <template v-if="clip.handInBody.frames">(worst {{ (clip.handInBody.worstHandShare * 100).toFixed(0) }}% at frame {{ clip.handInBody.worstFrame }})</template>
            </span>
          </p>
          <img :src="file(clip.sheet)" alt="" class="w-full rounded border border-white/10" />
        </div>
      </template>
    </section>
  </div>
</template>
