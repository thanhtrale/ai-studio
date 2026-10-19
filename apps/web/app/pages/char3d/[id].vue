<script setup lang="ts">
/**
 * One 3D character, its three steps kept apart: Reference -> Mesh -> Rig.
 *
 * Each tab is: pick the input from the previous step's GALLERY, generate,
 * see the runs in flight or waiting for a review, then this step's gallery.
 * The gallery holds only outputs that passed (a `pass` review, or added by
 * hand); everything else is under "All runs". Not showing what scored low is
 * deliberate -- the next step should only ever be offered a good input.
 *
 * `?tab=ref|mesh|rig|runs` is the tab and `?run=<id>` opens one run, so a run
 * is a link. The page polls every 4 s while a run is queued or running.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';

import type { Char3dDetail, Char3dGalleryItem, Char3dReviewEntry, Char3dRun, Char3dSheetSet, Char3dStep } from '#shared/char3d';
import { galleryKey, SHEET_VIEWS } from '#shared/char3d';

import Char3dLightbox from '../../components/char3d/Char3dLightbox.vue';
import RunDetail from '../../components/char3d/RunDetail.vue';
import UiAlert from '../../components/ui/Alert.vue';
import UiBadge from '../../components/ui/Badge.vue';
import UiButton from '../../components/ui/Button.vue';
import UiCard from '../../components/ui/Card.vue';
import UiCheckbox from '../../components/ui/Checkbox.vue';
import UiField from '../../components/ui/Field.vue';
import UiInput from '../../components/ui/Input.vue';
import UiSelect from '../../components/ui/Select.vue';
import { char3dReviewItems } from '../../utils/char3dReview';

type Tab = Char3dStep | 'runs';
const TABS: Tab[] = ['ref', 'mesh', 'rig', 'runs'];
const TAB_LABEL: Record<Tab, string> = { ref: 'Reference', mesh: 'Mesh', rig: 'Rig', runs: 'All runs' };
const TAB_TITLE: Record<Char3dStep, string> = { ref: 'Reference sheets', mesh: 'Meshes', rig: 'Rigs' };
const VERDICT_TONE = { pass: 'ok', retry: 'warn', fail: 'bad' } as const;
const STATUS_DOT: Record<string, string> = {
  done: 'bg-emerald-400',
  running: 'bg-indigo-400 animate-pulse',
  queued: 'bg-slate-500',
  error: 'bg-rose-400',
  cancelled: 'bg-slate-500',
};
/** An error stays among the step's pending runs for half a day, then only under "All runs". */
const ERROR_SHOW_MS = 12 * 3600_000;
const COUNTS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }));

const route = useRoute();
const router = useRouter();
const id = computed(() => String(route.params['id']));
const { data, refresh, error: loadError } = await useFetch<Char3dDetail>(() => `/api/char3d/${id.value}`);
useHead({ title: computed(() => data.value?.character.name ?? '3D character') });

const runs = computed(() => data.value?.runs ?? []);
const byId = computed(() => new Map(runs.value.map((run) => [run.id, run])));
const gallery = computed(() => data.value?.gallery ?? []);

const tab = ref<Tab>(TABS.includes(route.query['tab'] as Tab) ? (route.query['tab'] as Tab) : 'ref');
const openRun = ref(String(route.query['run'] ?? ''));
watch([tab, openRun], ([nextTab, run]) => void router.replace({ query: { tab: nextTab, ...(run ? { run } : {}) } }));
const detail = computed(() => (openRun.value ? byId.value.get(openRun.value) : undefined));

const live = computed(() => runs.value.some((run) => run.status === 'queued' || run.status === 'running'));
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => (timer = setInterval(() => live.value && void refresh(), 4000)));
onBeforeUnmount(() => timer && clearInterval(timer));

const file = (rel?: string): string => (rel ? `/api/char3d/${id.value}/file/${rel}` : '');

// --- the gallery, per step ---------------------------------------------------------
const galleryOfStep = (step: Tab): Char3dGalleryItem[] =>
  gallery.value.filter((item) => item.step === step && byId.value.has(item.run)).slice().reverse();
const inGallery = (run: string, set?: number): boolean =>
  gallery.value.some((item) => item.run === run && (item.set ?? -1) === (set ?? -1));
const meshRunOf = (run?: Char3dRun): string => String(run?.config['mesh'] ?? '').split('/')[1] ?? '';

/** A mesh or rig run's picture: the 45° turntable frame of its mesh run. */
function meshThumb(run?: Char3dRun): string {
  if (!run) return '';
  if (run.step === 'rig') return meshThumb(byId.value.get(meshRunOf(run)));
  const files = run.outputs?.['renders']?.files ?? {};
  const turntable = files['tex'] as string[] | undefined;
  return file(turntable?.[1] ?? turntable?.[0] ?? files['face_front']);
}

const actionError = ref<string | null>(null);

// --- the lightbox: one run's outputs, full size, for review -------------------------
const lightbox = ref<{ run: string; key: string } | null>(null);
const lightboxItems = computed(() => {
  const run = lightbox.value ? byId.value.get(lightbox.value.run) : undefined;
  return run ? char3dReviewItems(run) : [];
});
/** Open a run's outputs at one item, or at the first (the mesh or the rig itself). */
function review(run: string, key?: string): void {
  const items = byId.value.has(run) ? char3dReviewItems(byId.value.get(run)!) : [];
  const start = items.find((item) => item.key === key) ?? items[0];
  if (start) lightbox.value = { run, key: start.key };
}
function reviewDetails(run: string): void {
  lightbox.value = null;
  openRun.value = run;
}

async function setGallery(add: boolean, run: string, set?: number): Promise<void> {
  actionError.value = null;
  const query = { run, ...(set !== undefined ? { set } : {}) };
  try {
    if (add) await $fetch(`/api/char3d/${id.value}/gallery`, { method: 'POST', body: query });
    else await $fetch(`/api/char3d/${id.value}/gallery`, { method: 'DELETE', query });
    await refresh();
  } catch (error) {
    actionError.value = describeFetchError(error);
  }
}

// --- runs in flight or waiting for a review (a retry or fail is only under All runs) ---
const pendingOf = (step: Tab): Char3dRun[] =>
  runs.value
    .filter((run) => run.step === step)
    .filter(
      (run) =>
        run.status === 'queued' ||
        run.status === 'running' ||
        (run.status === 'done' && !run.review && !gallery.value.some((item) => item.run === run.id)) ||
        (run.status === 'error' && !run.review && Date.now() - (run.finishedAt ?? run.createdAt) < ERROR_SHOW_MS),
    )
    .slice()
    .reverse();
const sheetSets = (run: Char3dRun): Char3dSheetSet[] => (run.outputs?.['sets'] ?? []) as Char3dSheetSet[];
const pct = (value?: number): string => (value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const statusText = (run: Char3dRun): string =>
  run.status === 'done' ? 'awaiting review' : run.status === 'running' ? (run.stage ?? 'running') : run.status;

// --- the next step's input ----------------------------------------------------------
const pickRef = ref('');
const pickMesh = ref('');
const refItems = computed(() => galleryOfStep('ref'));
const meshItems = computed(() => galleryOfStep('mesh'));
watchEffect(() => {
  if (!refItems.value.some((item) => galleryKey(item) === pickRef.value)) {
    pickRef.value = refItems.value[0] ? galleryKey(refItems.value[0]) : '';
  }
  if (!meshItems.value.some((item) => item.run === pickMesh.value)) pickMesh.value = meshItems.value[0]?.run ?? '';
});
const pickedRef = computed(() => refItems.value.find((item) => galleryKey(item) === pickRef.value));

function useForNext(item: Char3dGalleryItem): void {
  if (item.step === 'ref') {
    pickRef.value = galleryKey(item);
    tab.value = 'mesh';
  } else if (item.step === 'mesh') {
    pickMesh.value = item.run;
    tab.value = 'rig';
  }
  openRun.value = '';
}

// --- generate -----------------------------------------------------------------------
const refBatch = ref('4');
const refExtra = ref('');
const meshCount = ref('1');
const meshReproject = ref(true);
const busy = ref(false);

async function post(body: Record<string, unknown>): Promise<void> {
  await $fetch(`/api/char3d/${id.value}/runs`, { method: 'POST', body });
}

async function generate(): Promise<void> {
  actionError.value = null;
  busy.value = true;
  try {
    if (tab.value === 'ref') {
      const extra = refExtra.value.trim();
      await post({
        step: 'ref',
        intent: `sheet ×${refBatch.value}${extra ? ` — ${extra}` : ''}`,
        config: { mode: 'sheet', batch: Number(refBatch.value), extra },
      });
    } else if (tab.value === 'mesh') {
      const item = pickedRef.value;
      if (!item?.views) throw new Error('Pick a reference from the gallery first');
      const views = Object.fromEntries(SHEET_VIEWS.filter((view) => item.views?.[view]).map((view) => [view, item.views?.[view]]));
      // A random seed each: the seed decides the face, the hair colour and how
      // well the mesh rigs, and the only measured way through is several tries.
      for (let index = 0; index < Number(meshCount.value); index += 1) {
        await post({
          step: 'mesh',
          parent: item.run,
          intent: `mesh from ${item.run}${item.set !== undefined ? ` sheet ${item.set}` : ''}, random seed`,
          config: { views, ...(meshReproject.value ? {} : { reproject: false }) },
        });
      }
    } else if (tab.value === 'rig') {
      const mesh = byId.value.get(pickMesh.value);
      if (!mesh?.outputs?.['glb']) throw new Error('Pick a mesh from the gallery first');
      await post({ step: 'rig', parent: mesh.id, intent: `rig ${mesh.id}`, config: { mesh: mesh.outputs['glb'] } });
    }
    await refresh();
  } catch (error) {
    actionError.value = describeFetchError(error);
  } finally {
    busy.value = false;
  }
}

// --- the animation review list --------------------------------------------------------
const { data: reviewList, refresh: refreshReviewList } = await useFetch<{ saved: Char3dReviewEntry[] }>('/api/char3d-review');
const savedForReview = (run: string): boolean => !!reviewList.value?.saved.some((entry) => entry.id === `${id.value}-${run}`);

async function saveForReview(run: string, open: boolean): Promise<void> {
  actionError.value = null;
  try {
    if (!savedForReview(run)) {
      await $fetch('/api/char3d-review', { method: 'POST', body: { character: id.value, run } });
      await refreshReviewList();
    }
    if (open) await navigateTo(`/char3d/review?c=${id.value}-${run}`);
  } catch (error) {
    actionError.value = describeFetchError(error);
  }
}

const showNotes = ref(false);
const counts = computed<Record<Tab, number>>(() => ({
  ref: refItems.value.length,
  mesh: meshItems.value.length,
  rig: galleryOfStep('rig').length,
  runs: runs.value.length,
}));
const running = (step: Tab): number =>
  runs.value.filter((run) => (step === 'runs' || run.step === step) && (run.status === 'queued' || run.status === 'running')).length;
</script>

<template>
  <div class="flex h-full">
    <aside class="w-64 shrink-0 space-y-4 overflow-y-auto border-r border-white/10 p-4">
      <NuxtLink to="/char3d" class="text-sm text-slate-400 hover:text-slate-100">← 3D characters</NuxtLink>
      <div v-if="data" class="flex gap-3">
        <img :src="file(data.character.ref)" alt="" class="h-20 w-16 shrink-0 rounded border border-white/10 bg-white object-contain" />
        <div class="min-w-0">
          <p class="truncate font-medium">{{ data.character.name }}</p>
          <p class="truncate text-xs text-slate-400">{{ data.character.subject }} · {{ data.character.style }}</p>
        </div>
      </div>
      <nav class="space-y-1">
        <button
          v-for="(entry, index) in TABS"
          :key="entry"
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors"
          :class="tab === entry && !detail ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'"
          @click="
            tab = entry;
            openRun = '';
          "
        >
          <span class="w-3 text-xs text-slate-500">{{ entry === 'runs' ? '' : index + 1 }}</span>
          <span class="flex-1">{{ TAB_LABEL[entry] }}</span>
          <span v-if="running(entry)" class="text-xs text-indigo-300" :title="`${running(entry)} queued or running`">⧗{{ running(entry) }}</span>
          <span class="text-xs text-slate-500" :title="entry === 'runs' ? 'All runs' : 'Items in the gallery'">{{ counts[entry] }}</span>
        </button>
      </nav>
      <section v-if="data?.character.notes?.length" class="space-y-1">
        <button type="button" class="text-left text-sm text-slate-400 hover:text-slate-100" @click="showNotes = !showNotes">
          Learnings ({{ data.character.notes.length }})
        </button>
        <ul v-if="showNotes" class="list-disc space-y-1 pl-4 text-xs text-slate-300">
          <li v-for="(note, index) in data.character.notes" :key="index">{{ note.text }}</li>
        </ul>
      </section>
      <section v-if="data?.character.traits" class="space-y-1 text-xs text-slate-500">
        <p class="text-slate-400">Traits in every prompt</p>
        <p>{{ data.character.traits }}</p>
      </section>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto p-6">
      <UiAlert v-if="loadError" tone="error">{{ describeFetchError(loadError) }}</UiAlert>
      <div v-else-if="data" class="mx-auto max-w-6xl space-y-5">
        <UiAlert v-if="actionError" tone="error">{{ actionError }}</UiAlert>

        <RunDetail
          v-if="detail"
          :char-id="id"
          :character="data.character"
          :runs="runs"
          :run="detail"
          :in-gallery="(set?: number) => inGallery(detail!.id, set)"
          :saved-for-review="savedForReview(detail.id)"
          :back-label="TAB_LABEL[tab]"
          @open="openRun = $event"
          @back="openRun = ''"
          @refresh="refresh()"
          @gallery="(add: boolean, set?: number) => setGallery(add, detail!.id, set)"
          @save-for-review="saveForReview(detail!.id, false)"
        />

        <!-- every run -->
        <template v-else-if="tab === 'runs'">
          <h1 class="text-xl font-semibold">All runs</h1>
          <p class="text-sm text-slate-400">Every attempt, including the ones that did not pass review.</p>
          <div class="space-y-1">
            <button
              v-for="run in runs.slice().reverse()"
              :key="run.id"
              type="button"
              class="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-white/5"
              @click="openRun = run.id"
            >
              <span class="size-2 shrink-0 rounded-full" :class="STATUS_DOT[run.status] ?? 'bg-slate-500'" />
              <b class="w-24 shrink-0 font-mono text-sm">{{ run.id }}</b>
              <span class="min-w-0 flex-1 truncate text-xs text-slate-400">{{ run.intent }}</span>
              <span v-if="gallery.some((item) => item.run === run.id)" class="text-xs text-emerald-300" title="In the gallery">✓</span>
              <UiBadge v-if="run.review" :tone="VERDICT_TONE[run.review.verdict]">{{ run.review.score }}</UiBadge>
              <span v-else-if="run.status !== 'done'" class="text-xs" :class="run.status === 'error' ? 'text-rose-300' : 'text-indigo-300'">
                {{ statusText(run) }}
              </span>
            </button>
          </div>
        </template>

        <!-- one step: input, generate, in flight, gallery -->
        <template v-else>
          <h1 class="text-xl font-semibold">{{ TAB_TITLE[tab] }}</h1>

          <UiCard>
            <div class="space-y-4 p-4">
              <template v-if="tab === 'ref'">
                <div class="flex flex-wrap items-end gap-4">
                  <img :src="file(data.character.ref)" alt="" class="h-28 rounded border border-white/10 bg-white object-contain" title="Original reference" />
                  <div class="min-w-64 flex-1 space-y-2">
                    <p class="text-xs text-slate-400">
                      One generation draws front · left · back side by side at 2048×1024, then the sheet is split
                      and cross-checked (width front vs back within 5%, heights within 3%). The outfit comes from
                      the character's traits.
                    </p>
                    <UiField label="Change for this run" for="ref-extra" hint="Optional, in English.">
                      <UiInput id="ref-extra" v-model="refExtra" placeholder="remove the long hanging ribbon tails" />
                    </UiField>
                  </div>
                  <div class="w-24">
                    <UiField label="Sheets" for="ref-batch"><UiSelect id="ref-batch" v-model="refBatch" :options="COUNTS" /></UiField>
                  </div>
                </div>
              </template>

              <template v-else-if="tab === 'mesh'">
                <p class="text-sm font-medium">Input — a reference sheet from the gallery</p>
                <p v-if="!refItems.length" class="text-sm text-slate-500">
                  No reference in the gallery yet. Generate sheets in step 1 and review or add a good one.
                </p>
                <div class="flex gap-2 overflow-x-auto pb-1">
                  <button
                    v-for="item in refItems"
                    :key="galleryKey(item)"
                    type="button"
                    class="shrink-0 space-y-1 rounded border-2 p-1"
                    :class="pickRef === galleryKey(item) ? 'border-indigo-400' : 'border-transparent hover:border-white/20'"
                    @click="pickRef = galleryKey(item)"
                  >
                    <span class="flex gap-0.5">
                      <img v-for="view in SHEET_VIEWS.filter((v) => item.views?.[v])" :key="view" :src="file(item.views?.[view])" alt="" class="h-24 w-16 rounded bg-white object-contain" />
                    </span>
                    <span class="block text-xs text-slate-500">{{ item.run }}{{ item.set !== undefined ? ` · sheet ${item.set}` : '' }}</span>
                  </button>
                </div>
                <div class="flex flex-wrap items-end gap-4">
                  <div class="w-24">
                    <UiField label="Runs" for="mesh-count"><UiSelect id="mesh-count" v-model="meshCount" :options="COUNTS" /></UiField>
                  </div>
                  <UiCheckbox
                    v-model="meshReproject"
                    label="Re-project colours"
                    hint="Projects the input views' colours back onto the texture: fixes the face, hairpins and colour drift."
                  />
                  <p class="text-xs text-slate-500">front + left + back · a random seed each · runs one after another</p>
                </div>
              </template>

              <template v-else>
                <p class="text-sm font-medium">Input — a mesh from the gallery</p>
                <p v-if="!meshItems.length" class="text-sm text-slate-500">
                  No mesh in the gallery yet. Generate meshes in step 2 and review or add a good one.
                </p>
                <div class="flex gap-2 overflow-x-auto pb-1">
                  <button
                    v-for="item in meshItems"
                    :key="item.run"
                    type="button"
                    class="shrink-0 space-y-1 rounded border-2 p-1"
                    :class="pickMesh === item.run ? 'border-indigo-400' : 'border-transparent hover:border-white/20'"
                    @click="pickMesh = item.run"
                  >
                    <img :src="meshThumb(byId.get(item.run))" alt="" class="h-28 w-24 rounded bg-white object-contain" />
                    <span class="block text-xs text-slate-500">{{ item.run }}</span>
                  </button>
                </div>
                <p class="text-xs text-slate-500">
                  Prep remesh → Make-It-Animatable joints → SkinTokens weights → Blender bind, then six Mixamo clips
                  with arm space 30° and torso clearance. Rig at least two meshes: the mesh's seed decides how well it rigs.
                </p>
              </template>

              <UiButton
                variant="primary"
                :disabled="busy || (tab === 'mesh' && !pickedRef) || (tab === 'rig' && !pickMesh)"
                @click="generate"
              >
                {{ tab === 'ref' ? 'Generate sheets' : tab === 'mesh' ? 'Generate mesh' : 'Rig' }}
              </UiButton>
            </div>
          </UiCard>

          <section v-if="pendingOf(tab).length" class="space-y-2">
            <p class="text-sm font-medium">In progress and awaiting review</p>
            <UiCard v-for="run in pendingOf(tab)" :key="run.id">
              <div class="space-y-2 p-3">
                <div class="flex items-center gap-2 text-sm">
                  <span class="size-2 shrink-0 rounded-full" :class="STATUS_DOT[run.status] ?? 'bg-slate-500'" />
                  <b class="font-mono">{{ run.id }}</b>
                  <span class="min-w-0 flex-1 truncate text-xs text-slate-400">{{ run.intent }}</span>
                  <span class="text-xs" :class="run.status === 'error' ? 'text-rose-300' : 'text-indigo-300'">{{ statusText(run) }}</span>
                  <UiButton size="sm" variant="ghost" @click="openRun = run.id">Details</UiButton>
                </div>
                <p v-if="run.error" class="text-xs text-rose-300">{{ run.error }}</p>
                <div v-if="run.step === 'ref' && run.status === 'done'" class="flex flex-wrap gap-2">
                  <div v-for="set in sheetSets(run)" :key="set.index" class="space-y-1 rounded border border-white/10 p-1">
                    <span v-if="set.views" class="flex gap-0.5">
                      <button
                        v-for="view in SHEET_VIEWS"
                        :key="view"
                        type="button"
                        class="cursor-zoom-in"
                        :title="`Review sheet ${set.index} · ${view}`"
                        @click="review(run.id, `sheet-${set.index}-${view}`)"
                      >
                        <img :src="file(set.views[view])" alt="" class="h-32 w-24 rounded bg-white object-contain" />
                      </button>
                    </span>
                    <button v-else type="button" class="cursor-zoom-in" :title="`Review sheet ${set.index}`" @click="review(run.id, `sheet-${set.index}`)">
                      <img :src="file(set.sheet)" alt="" class="h-32 rounded bg-white object-contain opacity-60" />
                    </button>
                    <div class="flex items-center gap-2 text-xs">
                      <span :class="set.check.ok ? 'text-emerald-300' : 'text-amber-300'">
                        {{ set.views ? `w ${pct(set.check.widthDiff)} · h ${pct(set.check.heightDiff)}` : `${set.check.segments} figures` }}
                      </span>
                      <span class="flex-1" />
                      <UiButton v-if="set.views" size="sm" title="Add this sheet to the gallery" @click="setGallery(true, run.id, set.index)">
                        Add
                      </UiButton>
                    </div>
                  </div>
                </div>
                <div v-else-if="run.status === 'done'" class="flex items-end gap-2">
                  <button type="button" class="cursor-zoom-in" :title="`Review ${run.id}`" @click="review(run.id)">
                    <img :src="meshThumb(run)" alt="" class="h-36 rounded bg-white object-contain" />
                  </button>
                  <div class="space-y-1">
                    <UiButton size="sm" variant="primary" @click="review(run.id)">Review {{ run.step === 'rig' ? 'rig' : 'mesh' }}</UiButton>
                    <UiButton size="sm" @click="setGallery(true, run.id)">Add to gallery</UiButton>
                  </div>
                </div>
              </div>
            </UiCard>
          </section>

          <section class="space-y-2">
            <p class="text-sm font-medium">
              Gallery <span class="font-normal text-slate-500">— outputs that passed review; pick one to run the next step</span>
            </p>
            <p v-if="!galleryOfStep(tab).length" class="text-sm text-slate-500">Nothing here yet.</p>
            <div class="flex flex-wrap gap-3">
              <UiCard v-for="item in galleryOfStep(tab)" :key="galleryKey(item)" :class="tab === 'ref' ? 'w-80' : 'w-52'">
                <div class="space-y-2 p-2">
                  <button
                    type="button"
                    class="flex w-full cursor-zoom-in justify-center gap-0.5 rounded bg-white"
                    :title="`Review ${item.run}`"
                    @click="review(item.run, item.set !== undefined ? `sheet-${item.set}-front` : undefined)"
                  >
                    <template v-if="item.step === 'ref'">
                      <img v-for="view in SHEET_VIEWS.filter((v) => item.views?.[v])" :key="view" :src="file(item.views?.[view])" alt="" class="h-44 w-1/3 object-contain" loading="lazy" />
                    </template>
                    <img v-else :src="meshThumb(byId.get(item.run))" alt="" class="h-56 w-full object-contain" loading="lazy" />
                  </button>
                  <div class="flex items-center gap-1.5 text-xs">
                    <b class="font-mono">{{ item.run }}</b>
                    <span v-if="item.set !== undefined" class="text-slate-500">sheet {{ item.set }}</span>
                    <span v-if="item.step === 'rig'" class="text-slate-500">← {{ meshRunOf(byId.get(item.run)) }}</span>
                    <UiBadge v-if="byId.get(item.run)?.review" :tone="VERDICT_TONE[byId.get(item.run)!.review!.verdict]">
                      {{ byId.get(item.run)!.review!.score }}
                    </UiBadge>
                    <span v-else class="text-slate-500" title="Added by hand">by hand</span>
                    <span class="flex-1" />
                    <button type="button" class="text-slate-500 hover:text-slate-100" :title="`Open ${item.run}`" @click="openRun = item.run">
                      Details
                    </button>
                    <button
                      type="button"
                      class="text-slate-500 hover:text-rose-300"
                      title="Remove from the gallery (the run is kept)"
                      aria-label="Remove from the gallery"
                      @click="setGallery(false, item.run, item.set)"
                    >
                      ✕
                    </button>
                  </div>
                  <p v-if="byId.get(item.run)?.review?.summary" class="line-clamp-2 text-xs text-slate-400">
                    {{ byId.get(item.run)!.review!.summary }}
                  </p>
                  <UiButton v-if="item.step !== 'rig'" size="sm" class="w-full" @click="useForNext(item)">
                    {{ item.step === 'ref' ? 'Make mesh →' : 'Rig →' }}
                  </UiButton>
                  <UiButton v-else size="sm" class="w-full" @click="saveForReview(item.run, true)">
                    {{ savedForReview(item.run) ? 'Animation review →' : 'Save and review →' }}
                  </UiButton>
                </div>
              </UiCard>
            </div>
          </section>
        </template>
      </div>
    </main>

    <Char3dLightbox
      v-if="data && !detail"
      :char-id="id"
      :reference="data.character.ref"
      :items="lightboxItems"
      :current="lightbox?.key ?? null"
      :heading="lightbox?.run"
      @close="lightbox = null"
      @navigate="(key: string) => lightbox && (lightbox = { run: lightbox.run, key })"
    >
      <template #actions="{ item }">
        <!-- A sheet run's gallery entries are per sheet: only an item that belongs to one can add it. -->
        <template v-if="lightbox && (byId.get(lightbox.run)?.step !== 'ref' || item.set !== undefined)">
          <UiButton
            v-if="inGallery(lightbox!.run, item.set)"
            size="sm"
            title="Remove from the gallery (the run is kept)"
            @click="setGallery(false, lightbox!.run, item.set)"
          >
            In gallery ✓
          </UiButton>
          <UiButton v-else size="sm" title="Add to the gallery so the next step can use it" @click="setGallery(true, lightbox!.run, item.set)">
            Add {{ item.set !== undefined ? `sheet ${item.set}` : '' }} to gallery
          </UiButton>
        </template>
        <UiButton size="sm" variant="primary" title="Open the run: score it, see its config and timing" @click="reviewDetails(lightbox!.run)">
          Score / details
        </UiButton>
      </template>
    </Char3dLightbox>
  </div>
</template>
