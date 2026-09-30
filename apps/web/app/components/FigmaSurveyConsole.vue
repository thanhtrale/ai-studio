<script setup lang="ts">
/**
 * The Figma survey console: one link in, an index of the whole file out.
 *
 * Three columns rather than the generate consoles' inputs-work-telemetry,
 * because what this produces is not a document to read top to bottom but a
 * thing to navigate. The middle column is the index -- modules, their
 * components, and the screens -- and the right is whatever is selected, with
 * its renders at the sizes they were drawn at.
 *
 * The run's timeline lives in that same right-hand pane rather than in a fourth
 * column. A survey is long and mostly unattended, and while it is running there
 * is nothing selected to look at anyway; once it finishes the timeline is one
 * click away and the space belongs to the result.
 *
 * Nothing here renames anything. Every component is shown under the string the
 * crawl read out of Figma, in a monospaced face, because that string is what a
 * developer has to type and what an agent has to match on.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import type {
  SurveyComponent,
  SurveyInventory,
  SurveyModule,
  SurveyRecord,
  SurveyResult,
  SurveyScreen,
  SurveySection,
  SurveyViewport,
} from '#shared/survey';
import { DEFAULT_SURVEY_OPTIONS, mcpCallFor, readSurveyRoots } from '#shared/survey';
import { ueFileNameFor, ueModelFor } from '#shared/ue-model';

import JobTimeline from './JobTimeline.vue';
import VramChart from './VramChart.vue';
import UiAlert from './ui/Alert.vue';
import UiBadge from './ui/Badge.vue';
import UiButton from './ui/Button.vue';
import UiCard from './ui/Card.vue';
import UiCheckbox from './ui/Checkbox.vue';
import UiField from './ui/Field.vue';
import UiInput from './ui/Input.vue';
import UiNumberInput from './ui/NumberInput.vue';
import UiSectionTitle from './ui/SectionTitle.vue';
import UiSelect from './ui/Select.vue';
import UiTextarea from './ui/Textarea.vue';

const props = defineProps<{ arms: ArmSummary[] }>();

const links = ref('');
const title = ref('');
const armId = ref('');
const options = ref({ ...DEFAULT_SURVEY_OPTIONS });

const failure = ref('');
const running = ref(false);
/** Consecutive index polls that did not land. Reset by the first that does. */
const misses = ref(0);
const surveyId = ref('');
const record = ref<SurveyRecord | null>(null);
const inventory = ref<SurveyInventory | null>(null);
const history = ref<SurveyRecord[]>([]);

type Selection =
  | { kind: 'run' }
  | { kind: 'overview' }
  | { kind: 'screen'; id: string }
  | { kind: 'section'; id: string; screenId: string }
  | { kind: 'component'; id: string }
  | { kind: 'module'; id: string };

const selection = ref<Selection>({ kind: 'overview' });
const filter = ref('');
const openModules = ref(new Set<string>());
const openScreens = ref(new Set<string>());
/** Components as a flat list, or grouped under the modules they belong to. */
const componentView = ref<'flat' | 'module'>('flat');

const { job, machine, armVram, capacityGib, available, elapsedSeconds, watch: follow } = useJobTelemetry();

/** Only arms that can actually answer a chat. Modality alone would offer more. */
const candidates = computed(() => props.arms.filter((arm) => arm.capabilities.includes('text.generate')));
const armOptions = computed(() => candidates.value.map((arm) => ({ value: arm.id, label: arm.name || arm.id })));

// The select would otherwise render blank until a choice is made, while the
// submit quietly used the first arm -- two different answers to "which model".
watchEffect(() => {
  const first = candidates.value[0];
  if (first && !candidates.value.some((arm) => arm.id === armId.value)) armId.value = first.id;
});

/**
 * What the server will make of what has been typed, recomputed as it is typed.
 *
 * The same function the route uses, so the console cannot accept a link the
 * server then refuses. A survey is minutes; a link rejected at the end of one
 * is a link that could have been rejected before it started.
 */
const reading = computed(() =>
  links.value.trim() ? readSurveyRoots(links.value) : { roots: [], problems: [] },
);

const ready = computed(
  () =>
    reading.value.roots.length > 0 &&
    reading.value.problems.length === 0 &&
    (!options.value.describe || candidates.value.length > 0),
);

function messageOf(error: unknown): string {
  const data = (error as { data?: { data?: { message?: string }; message?: string } })?.data;
  return data?.data?.message ?? data?.message ?? (error as Error)?.message ?? 'something went wrong';
}

function newSurveyId(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `survey-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadHistory(): Promise<void> {
  try {
    history.value = (await $fetch<{ surveys: SurveyRecord[] }>('/api/survey')).surveys;
  } catch {
    // A history that will not load is not worth a banner over the form.
  }
}

/**
 * Reads whatever the survey has written so far.
 *
 * Called while the run is still going, because the index is on disk from the
 * moment the crawl ends and the renders and descriptions only fill it in. A
 * reader can open screens minutes before the run finishes.
 *
 * A poll that fails is not a survey that failed, and the two must not be shown
 * as the same thing. The run lives in the server process and the index lives on
 * disk; a request that does not land -- the dev server reloading, a write in
 * progress -- says nothing about either. Only the timeline decides whether a
 * run has stopped, so a miss here is counted and otherwise ignored.
 */
async function loadResult(id: string, { quiet = false } = {}): Promise<void> {
  try {
    const answer = await $fetch<SurveyResult>(`/api/survey/${encodeURIComponent(id)}/result`);
    misses.value = 0;
    record.value = answer.record;
    inventory.value = answer.inventory ?? null;
  } catch (error) {
    misses.value += 1;
    if (!quiet) failure.value = messageOf(error);
  }
}


let poll: ReturnType<typeof setInterval> | undefined;

function stopPolling(): void {
  if (poll) clearInterval(poll);
  poll = undefined;
}

// The telemetry composable stops itself when the run ends; the index poll has
// to be told, and it is the timeline's state that says when.
watch(
  () => job.value?.state,
  (state) => {
    if (state !== 'done' && state !== 'failed') return;
    stopPolling();
    running.value = false;
    if (surveyId.value) void loadResult(surveyId.value).then(loadHistory);
    if (state === 'failed' && job.value?.detail) failure.value = job.value.detail;
  },
);

async function start(): Promise<void> {
  if (!ready.value || running.value) return;

  failure.value = '';
  misses.value = 0;
  inventory.value = null;
  record.value = null;
  running.value = true;
  selection.value = { kind: 'run' };

  // Chosen here rather than received, so progress can be polled from the first
  // moment. A survey reports its steps from this application, not from the
  // supervisor, so the source has to be named.
  const id = newSurveyId();
  surveyId.value = id;
  follow(id, 'survey');

  try {
    await $fetch('/api/survey', {
      method: 'POST',
      body: {
        surveyId: id,
        title: title.value.trim() || undefined,
        links: links.value,
        armId: options.value.describe ? armId.value : undefined,
        options: options.value,
      },
    });
    await loadHistory();
    stopPolling();
    poll = setInterval(() => void loadResult(id, { quiet: true }), 3_000);
  } catch (error) {
    running.value = false;
    failure.value = messageOf(error);
  }
}

/** Opens a finished survey out of the list, without rerunning anything. */
async function open(entry: SurveyRecord): Promise<void> {
  stopPolling();
  running.value = false;
  misses.value = 0;
  failure.value = entry.state === 'failed' ? (entry.detail ?? '') : '';
  surveyId.value = entry.surveyId;
  links.value = entry.links;
  title.value = entry.title;
  options.value = { ...entry.options };
  selection.value = { kind: 'overview' };
  await loadResult(entry.surveyId);
}

/** The same file, the same settings, a fresh crawl. */
async function rerun(entry: SurveyRecord): Promise<void> {
  links.value = entry.links;
  title.value = entry.title;
  options.value = { ...entry.options };
  await start();
}

async function forget(entry: SurveyRecord): Promise<void> {
  try {
    await $fetch(`/api/survey/${encodeURIComponent(entry.surveyId)}`, { method: 'DELETE' });
    if (surveyId.value === entry.surveyId) {
      surveyId.value = '';
      inventory.value = null;
      record.value = null;
    }
    await loadHistory();
  } catch (error) {
    failure.value = messageOf(error);
  }
}

onMounted(() => void loadHistory());
onBeforeUnmount(stopPolling);

/* -- the index ------------------------------------------------------------ */

const needle = computed(() => filter.value.trim().toLowerCase());

function matches(value: string): boolean {
  return !needle.value || value.toLowerCase().includes(needle.value);
}

const screens = computed(() => inventory.value?.screens ?? []);
const components = computed(() => inventory.value?.components ?? []);
const modules = computed(() => inventory.value?.modules ?? []);

const componentById = computed(
  () => new Map(components.value.map((component) => [component.id, component])),
);
const screenById = computed(() => new Map(screens.value.map((screen) => [screen.id, screen])));
const moduleById = computed(() => new Map(modules.value.map((module) => [module.id, module])));

/** Nested components are known by name; this is how that name is followed. */
const componentByName = computed(
  () => new Map(components.value.map((component) => [component.name.toLowerCase(), component.id])),
);

function selectByName(name: string): void {
  const id = componentByName.value.get(name.toLowerCase());
  if (id) selection.value = { kind: 'component', id };
}

const visibleScreens = computed(() =>
  screens.value.filter((screen) => matches(screen.name) || matches(screen.page)),
);

/** Busiest first: a component used forty times is the one worth reading about. */
const visibleComponents = computed(() =>
  components.value
    .filter((component) => matches(component.name))
    .slice()
    .sort((a, b) => b.instances - a.instances || a.name.localeCompare(b.name)),
);

/** A module survives the filter when it, or any of its components, matches. */
const visibleModules = computed(() =>
  modules.value
    .map((module) => ({
      module,
      componentIds: module.componentIds.filter((id) => {
        const component = componentById.value.get(id);
        return component ? matches(component.name) : false;
      }),
    }))
    .filter((entry) => matches(entry.module.name) || entry.componentIds.length > 0),
);

function toggleModule(id: string): void {
  const next = new Set(openModules.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openModules.value = next;
}

function isOpen(id: string): boolean {
  // A filter that matched inside a module should show what it matched, not a
  // collapsed row the reader has to guess at.
  return openModules.value.has(id) || Boolean(needle.value);
}

const selectedScreen = computed<SurveyScreen | null>(() =>
  selection.value.kind === 'screen' ? (screenById.value.get(selection.value.id) ?? null) : null,
);
const selectedComponent = computed<SurveyComponent | null>(() =>
  selection.value.kind === 'component' ? (componentById.value.get(selection.value.id) ?? null) : null,
);
const selectedModule = computed<SurveyModule | null>(() =>
  selection.value.kind === 'module' ? (moduleById.value.get(selection.value.id) ?? null) : null,
);

const selectedSection = computed<{ screen: SurveyScreen; section: SurveySection } | null>(() => {
  const current = selection.value;
  if (current.kind !== 'section') return null;
  const screen = screenById.value.get(current.screenId);
  const section = screen?.sections.find((entry) => entry.id === current.id);
  return screen && section ? { screen, section } : null;
});

function toggleScreen(id: string): void {
  const next = new Set(openScreens.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openScreens.value = next;
}

/**
 * The Universal Editor model for the open section.
 *
 * Assembled in the browser from the fields the server read, rather than fetched:
 * it is a pure function of the section, and a round trip for something already
 * on screen would be a round trip for nothing.
 */
const ueModel = computed(() => {
  const open = selectedSection.value;
  return open ? ueModelFor(open.section) : null;
});

const ueFileName = computed(() =>
  selectedSection.value ? ueFileNameFor(selectedSection.value.section) : '',
);

const ueJson = computed(() => (ueModel.value ? JSON.stringify(ueModel.value, null, 2) : ''));

const FIELD_TONE: Record<string, 'ok' | 'warn' | 'neutral' | 'accent'> = {
  text: 'neutral',
  richtext: 'neutral',
  image: 'accent',
  icon: 'accent',
  link: 'ok',
  container: 'neutral',
};

function shotUrl(name: string | undefined): string | null {
  if (!name || !surveyId.value) return null;
  return `/api/survey/${encodeURIComponent(surveyId.value)}/shot?name=${encodeURIComponent(name)}`;
}

const VIEWPORT_TONE: Record<SurveyViewport, 'ok' | 'warn' | 'neutral'> = {
  desktop: 'ok',
  tablet: 'neutral',
  mobile: 'neutral',
  other: 'neutral',
};

/** How much of the file was drawn at each width, for the overview. */
const coverage = computed(() => {
  const counts: Record<SurveyViewport, number> = { desktop: 0, tablet: 0, mobile: 0, other: 0 };
  for (const screen of screens.value) {
    for (const viewport of new Set(screen.views.map((view) => view.viewport))) counts[viewport] += 1;
  }
  return counts;
});

const copied = ref('');
async function copy(text: string, mark: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = mark;
    setTimeout(() => (copied.value = ''), 1500);
  } catch {
    // A denied clipboard is not worth an error banner; the text is on screen.
  }
}

function mcpFor(nodeId: string): string {
  return mcpCallFor(nodeId, inventory.value?.fileKey ?? '');
}

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

function initials(screen: SurveyScreen): string {
  return screen.views.map((view) => view.viewport.charAt(0).toUpperCase()).join('');
}
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <!-- What to survey, and what has been surveyed before -->
    <aside class="w-80 shrink-0 space-y-5 overflow-y-auto border-r border-white/10 p-5">
      <UiSectionTitle title="Figma file" />

      <UiField
        label="Links"
        for="survey-links"
        required
        hint="A link to the file, or one per page. Notes around a link are fine. They must all be in one file."
      >
        <UiTextarea
          id="survey-links"
          v-model="links"
          :rows="3"
          placeholder="https://www.figma.com/design/…"
        />
      </UiField>

      <ul v-if="reading.roots.length" class="space-y-0.5 text-xs text-slate-400">
        <li v-for="(root, at) in reading.roots" :key="root.nodeId ?? at" class="flex items-baseline gap-2">
          <span class="w-10 shrink-0 text-slate-500">{{ root.nodeId ? 'page' : 'file' }}</span>
          <code class="text-slate-300">{{ root.nodeId ?? root.fileKey }}</code>
          <span v-if="root.fileName" class="truncate">{{ root.fileName }}</span>
        </li>
      </ul>
      <p v-for="problem in reading.problems" :key="problem" class="text-xs text-rose-300">{{ problem }}</p>

      <UiField label="Name" for="survey-title" hint="What to call this in the list. The file's own name by default.">
        <UiInput id="survey-title" v-model="title" placeholder="Design system, autumn release" />
      </UiField>

      <UiSectionTitle title="What to capture" />

      <UiCheckbox
        v-model="options.screenshots"
        label="Render each screen"
        hint="Every frame of every screen, desktop through mobile. The slowest part of a crawl."
      />
      <UiCheckbox
        v-model="options.componentShots"
        label="Render each component"
        hint="A picture of the component itself, on its own budget so the screens cannot spend it."
      />

      <UiField
        label="Screen render budget"
        for="survey-shots"
        hint="Spent on one drawing of every screen before a second of any."
      >
        <UiNumberInput id="survey-shots" v-model="options.maxShots" :min="0" :max="300" :step="10" lazy />
      </UiField>

      <UiField
        label="Component render budget"
        for="survey-component-shots"
        hint="Spent busiest first, so a cap costs the components nobody uses."
      >
        <UiNumberInput
          id="survey-component-shots"
          v-model="options.maxComponentShots"
          :min="0"
          :max="400"
          :step="20"
          lazy
        />
      </UiField>

      <UiCheckbox
        v-model="options.resolveComponents"
        label="Read each component's main component"
        hint="The same jump the Inspect panel's arrow makes. Gets the real name and the layers inside, and reaches the library page even when nobody linked it."
      />

      <UiSectionTitle title="What to describe" />

      <UiCheckbox
        v-model="options.describe"
        label="Group and describe with a local model"
        hint="Components are grouped into modules and screens get a purpose. Off means grouping by name alone — faster, and still an index."
      />

      <template v-if="options.describe">
        <UiAlert v-if="candidates.length === 0" tone="warn">
          No discovered arm declares <code>text.generate</code>. Turn this off to crawl without a model.
        </UiAlert>

        <UiField v-else label="Arm" for="survey-arm" hint="Any arm that speaks text.generate.">
          <UiSelect id="survey-arm" v-model="armId" :options="armOptions" />
        </UiField>

        <UiField
          label="Screens to describe"
          for="survey-summaries"
          hint="Each is its own pass over that screen's layers. The rest are still listed."
        >
          <UiNumberInput
            id="survey-summaries"
            v-model="options.maxScreenSummaries"
            :min="0"
            :max="60"
            :step="2"
            lazy
          />
        </UiField>

        <UiField
          label="Blocks to model"
          for="survey-sections"
          hint="One pass per block, naming every slot an author fills in. Tallest first — a 900pt band is the page, a 40pt one is a divider."
        >
          <UiNumberInput
            id="survey-sections"
            v-model="options.maxSectionSummaries"
            :min="0"
            :max="120"
            :step="4"
            lazy
          />
        </UiField>
      </template>

      <UiButton variant="primary" class="w-full" :disabled="!ready || running" @click="start">
        {{ running ? 'Surveying…' : 'Analyze' }}
      </UiButton>

      <p class="text-xs text-slate-500">
        The Figma desktop app must be running with its local MCP server enabled, and the file open.
        Names are transcribed exactly as Figma spells them.
      </p>

      <template v-if="history.length">
        <UiSectionTitle title="Saved surveys" />

        <ul class="space-y-2">
          <li v-for="entry in history" :key="entry.surveyId">
            <UiCard class="p-3" :selected="entry.surveyId === surveyId">
              <button class="w-full space-y-1 text-left" @click="open(entry)">
                <span class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm text-slate-100">{{ entry.title }}</span>
                  <UiBadge :tone="entry.state === 'done' ? 'ok' : entry.state === 'failed' ? 'bad' : 'warn'">
                    {{ entry.state }}
                  </UiBadge>
                </span>
                <span class="block text-xs text-slate-500">{{ when(entry.startedAt) }}</span>
                <span v-if="entry.counts" class="block text-xs text-slate-400">
                  {{ entry.counts.screens }} screens · {{ entry.counts.components }} components ·
                  {{ entry.counts.shots }} renders
                </span>
              </button>
              <div class="mt-2 flex gap-2">
                <UiButton size="sm" variant="ghost" :disabled="running" @click="rerun(entry)">
                  Re-analyze
                </UiButton>
                <UiButton size="sm" variant="ghost" :disabled="running" @click="forget(entry)">
                  Delete
                </UiButton>
              </div>
            </UiCard>
          </li>
        </ul>
      </template>
    </aside>

    <!-- The index -->
    <aside
      v-if="inventory || running"
      class="flex w-72 shrink-0 flex-col overflow-hidden border-r border-white/10"
    >
      <div class="space-y-2 border-b border-white/10 p-3">
        <UiButton
          size="sm"
          class="w-full"
          :active="selection.kind === 'run'"
          @click="selection = { kind: 'run' }"
        >
          {{ running ? 'Running…' : 'Run detail' }}
        </UiButton>
        <UiButton
          size="sm"
          class="w-full"
          :active="selection.kind === 'overview'"
          @click="selection = { kind: 'overview' }"
        >
          Overview
        </UiButton>
        <UiInput v-model="filter" placeholder="Filter by name" />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
        <p class="px-1 pb-1 text-xs uppercase tracking-wide text-slate-500">
          Screens ({{ visibleScreens.length }})
        </p>
        <ul class="mb-4 space-y-0.5">
          <li v-for="screen in visibleScreens" :key="screen.id">
            <div class="flex items-center gap-1">
              <button
                class="w-5 shrink-0 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                :disabled="screen.sections.length === 0"
                @click="toggleScreen(screen.id)"
              >
                {{ openScreens.has(screen.id) ? '▾' : '▸' }}
              </button>
              <button
                class="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/5"
                :class="
                  selection.kind === 'screen' && selection.id === screen.id
                    ? 'bg-white/10 text-slate-100'
                    : 'text-slate-300'
                "
                @click="selection = { kind: 'screen', id: screen.id }"
              >
                <span class="min-w-0 flex-1 truncate">{{ screen.name }}</span>
                <span class="shrink-0 font-mono text-[10px] text-slate-500">{{ initials(screen) }}</span>
              </button>
            </div>

            <ul
              v-if="openScreens.has(screen.id)"
              class="ml-6 space-y-0.5 border-l border-white/10 pl-2"
            >
              <li v-for="section in screen.sections" :key="section.id">
                <button
                  class="flex w-full items-center gap-2 rounded px-2 py-0.5 text-left text-xs hover:bg-white/5"
                  :class="
                    selection.kind === 'section' && selection.id === section.id && selection.screenId === screen.id
                      ? 'bg-white/10 text-slate-100'
                      : 'text-slate-400'
                  "
                  @click="selection = { kind: 'section', id: section.id, screenId: screen.id }"
                >
                  <span class="min-w-0 flex-1 truncate">{{ section.name }}</span>
                  <span
                    v-if="section.orphans.length"
                    class="shrink-0 text-[10px] text-amber-400/80"
                    :title="section.orphans.length + ' layers no component covers'"
                  >
                    {{ section.orphans.length }}
                  </span>
                </button>
              </li>
            </ul>
          </li>
        </ul>

        <div class="flex items-center justify-between px-1 pb-1">
          <p class="text-xs uppercase tracking-wide text-slate-500">
            Components ({{ visibleComponents.length }})
          </p>
          <div class="flex gap-1">
            <button
              class="rounded px-1.5 py-0.5 text-[10px]"
              :class="componentView === 'flat' ? 'bg-white/10 text-slate-200' : 'text-slate-500 hover:text-slate-300'"
              @click="componentView = 'flat'"
            >
              all
            </button>
            <button
              class="rounded px-1.5 py-0.5 text-[10px]"
              :class="componentView === 'module' ? 'bg-white/10 text-slate-200' : 'text-slate-500 hover:text-slate-300'"
              @click="componentView = 'module'"
            >
              by module
            </button>
          </div>
        </div>

        <ul v-if="componentView === 'flat'" class="space-y-0.5">
          <li v-for="component in visibleComponents" :key="component.id">
            <button
              class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/5"
              :class="
                selection.kind === 'component' && selection.id === component.id
                  ? 'bg-white/10 text-slate-100'
                  : 'text-slate-300'
              "
              @click="selection = { kind: 'component', id: component.id }"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ component.name }}</span>
              <span class="shrink-0 text-[10px] text-slate-500">{{ component.instances }}</span>
            </button>
          </li>
        </ul>

        <ul v-else class="space-y-0.5">
          <li v-for="entry in visibleModules" :key="entry.module.id">
            <div class="flex items-center gap-1">
              <button
                class="w-5 shrink-0 text-slate-500 hover:text-slate-200"
                @click="toggleModule(entry.module.id)"
              >
                {{ isOpen(entry.module.id) ? '▾' : '▸' }}
              </button>
              <button
                class="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/5"
                :class="
                  selection.kind === 'module' && selection.id === entry.module.id
                    ? 'bg-white/10 text-slate-100'
                    : 'text-slate-300'
                "
                @click="selection = { kind: 'module', id: entry.module.id }"
              >
                <span class="min-w-0 flex-1 truncate">{{ entry.module.name }}</span>
                <span class="shrink-0 text-[10px] text-slate-500">{{ entry.componentIds.length }}</span>
              </button>
            </div>

            <ul v-if="isOpen(entry.module.id)" class="ml-6 space-y-0.5 border-l border-white/10 pl-2">
              <li v-for="id in entry.componentIds" :key="id">
                <button
                  class="w-full truncate rounded px-2 py-0.5 text-left font-mono text-xs hover:bg-white/5"
                  :class="
                    selection.kind === 'component' && selection.id === id
                      ? 'bg-white/10 text-slate-100'
                      : 'text-slate-400'
                  "
                  @click="selection = { kind: 'component', id }"
                >
                  {{ componentById.get(id)?.name }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>
    </aside>

    <!-- What is selected -->
    <section class="min-w-0 flex-1 overflow-y-auto p-6">
      <UiAlert v-if="failure" tone="error" title="The survey stopped" class="mb-4">{{ failure }}</UiAlert>

      <UiAlert v-else-if="misses >= 4" tone="warn" class="mb-4">
        The index has not answered for {{ misses * 3 }} seconds. The run is on the server, not in this
        page — it will catch up on its own.
      </UiAlert>

      <div v-if="!inventory && !running && !failure" class="mx-auto max-w-lg space-y-3 pt-16 text-center">
        <p class="text-2xl text-indigo-400">▤</p>
        <h2 class="text-base font-semibold text-slate-200">Nothing surveyed yet</h2>
        <p class="text-sm text-slate-400">
          Point this at a Figma file and it reads every page: what screens exist, which viewports each
          was drawn at, and every component by the name the designer gave it.
        </p>
        <p class="text-xs text-slate-500">
          The crawl itself uses no model — names and counts are read, not guessed. A local model is
          asked only which module a component belongs to and what a screen is for.
        </p>
      </div>

      <!-- The run -->
      <div v-else-if="selection.kind === 'run'" class="space-y-5">
        <header class="space-y-1">
          <h2 class="text-lg font-semibold">{{ record?.title || title || 'Survey' }}</h2>
          <p class="text-sm text-slate-400">
            {{
              running
                ? 'Crawling the file. The index fills in as it goes — open it from the left.'
                : 'What this run did.'
            }}
          </p>
        </header>

        <div class="grid gap-5 lg:grid-cols-2">
          <JobTimeline :job="job" :elapsed-seconds="elapsedSeconds" />
          <VramChart
            :machine="machine"
            :arm="armVram"
            :capacity-gib="capacityGib"
            :available="available"
          />
        </div>
      </div>

      <!-- Overview -->
      <div v-else-if="selection.kind === 'overview' && inventory" class="space-y-5">
        <header class="flex flex-wrap items-center gap-3">
          <h2 class="text-lg font-semibold">{{ record?.title }}</h2>
          <UiBadge tone="ok">{{ screens.length }} screens</UiBadge>
          <UiBadge tone="neutral">{{ components.length }} components</UiBadge>
          <UiBadge tone="neutral">{{ modules.length }} modules</UiBadge>
        </header>

        <UiCard class="space-y-2 p-4 text-sm">
          <div class="flex gap-2">
            <span class="w-24 shrink-0 text-slate-500">File</span>
            <code class="text-slate-300">{{ inventory.fileKey }}</code>
            <span v-if="inventory.fileName" class="text-slate-400">{{ inventory.fileName }}</span>
          </div>
          <div class="flex gap-2">
            <span class="w-24 shrink-0 text-slate-500">Drawn at</span>
            <span class="text-slate-300">
              {{ coverage.desktop }} desktop · {{ coverage.tablet }} tablet · {{ coverage.mobile }} mobile
              <template v-if="coverage.other"> · {{ coverage.other }} other</template>
            </span>
          </div>
          <div v-if="record?.endedAt" class="flex gap-2">
            <span class="w-24 shrink-0 text-slate-500">Finished</span>
            <span class="text-slate-300">{{ when(record.endedAt) }}</span>
          </div>
        </UiCard>

        <div v-if="inventory.pages.length">
          <UiSectionTitle title="Pages" />
          <ul class="mt-2 space-y-1 text-sm">
            <li v-for="page in inventory.pages" :key="page.nodeId" class="flex items-baseline gap-3">
              <span class="text-slate-200">{{ page.name }}</span>
              <span class="text-xs text-slate-500">{{ page.screenIds.length }} screens</span>
              <a
                :href="page.url"
                target="_blank"
                rel="noreferrer"
                class="text-xs text-indigo-300 hover:underline"
              >
                open in Figma
              </a>
            </li>
          </ul>
        </div>

        <UiAlert v-if="inventory.warnings.length" tone="warn" title="What the crawl could not do">
          <ul class="list-disc space-y-1 pl-4">
            <li v-for="warning in inventory.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </UiAlert>
      </div>

      <!-- One screen -->
      <div v-else-if="selectedScreen" class="space-y-5">
        <header class="space-y-2">
          <h2 class="text-lg font-semibold">{{ selectedScreen.name }}</h2>
          <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>{{ selectedScreen.page }}</span>
            <span v-if="selectedScreen.group">· {{ selectedScreen.group }}</span>
            <span>· {{ selectedScreen.nodeCount }} layers</span>
            <UiBadge
              v-for="view in selectedScreen.views"
              :key="view.nodeId"
              :tone="VIEWPORT_TONE[view.viewport]"
            >
              {{ view.viewport }} {{ view.width ?? '?' }}
            </UiBadge>
          </div>
        </header>

        <p v-if="selectedScreen.purpose" class="max-w-3xl text-sm text-slate-200">
          {{ selectedScreen.purpose }}
        </p>

        <div v-if="selectedScreen.sections.length">
          <UiSectionTitle title="Blocks, top to bottom" />
          <p class="mt-1 text-xs text-slate-500">
            Read off the design, not guessed. Click one to see what an author fills into it.
          </p>

          <ul class="mt-3 space-y-1.5">
            <li v-for="section in selectedScreen.sections" :key="section.id">
              <button
                class="w-full rounded border border-white/10 bg-surface-raised p-3 text-left hover:border-white/30"
                @click="selection = { kind: 'section', id: section.id, screenId: selectedScreen.id }"
              >
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs text-slate-500">{{ section.order + 1 }}</span>
                  <span class="min-w-0 flex-1 truncate text-sm text-slate-100">{{ section.name }}</span>
                  <UiBadge v-if="section.componentName" tone="ok">component</UiBadge>
                  <UiBadge v-else-if="section.componentIds.length" tone="neutral">
                    {{ section.componentIds.length }} components
                  </UiBadge>
                  <UiBadge v-else tone="warn">no component</UiBadge>
                  <span v-if="section.fields.length" class="text-xs text-slate-500">
                    {{ section.fields.length }} fields
                  </span>
                  <span v-if="section.orphans.length" class="text-xs text-amber-400/80">
                    {{ section.orphans.length }} loose
                  </span>
                </span>
                <span v-if="section.purpose" class="mt-1 block text-xs text-slate-400">
                  {{ section.purpose }}
                </span>
                <span v-else-if="section.componentName" class="mt-1 block font-mono text-xs text-slate-500">
                  {{ section.componentName }}
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div v-if="selectedScreen.content?.length">
          <UiSectionTitle title="Content it shows" />
          <ul class="mt-2 list-disc space-y-1 pl-4 text-sm text-slate-300">
            <li v-for="item in selectedScreen.content" :key="item">{{ item }}</li>
          </ul>
        </div>

        <UiSectionTitle title="Frames" />
        <div class="grid gap-4 xl:grid-cols-2">
          <UiCard v-for="view in selectedScreen.views" :key="view.nodeId" class="space-y-3 p-4">
            <div class="flex flex-wrap items-center gap-2">
              <UiBadge :tone="VIEWPORT_TONE[view.viewport]">{{ view.viewport }}</UiBadge>
              <span class="truncate text-sm text-slate-200">{{ view.name }}</span>
              <span class="text-xs text-slate-500">{{ view.width ?? '?' }} × {{ view.height ?? '?' }}</span>
            </div>

            <a v-if="shotUrl(view.shot)" :href="view.url" target="_blank" rel="noreferrer" class="block">
              <img
                :src="shotUrl(view.shot) ?? ''"
                :alt="view.name"
                class="max-h-[32rem] w-full rounded border border-white/10 bg-white/5 object-contain"
                loading="lazy"
              >
            </a>
            <p
              v-else
              class="rounded border border-dashed border-white/10 p-6 text-center text-xs text-slate-500"
            >
              not rendered — the budget ran out, or Figma refused this frame
            </p>

            <div class="space-y-1 text-xs">
              <div class="flex items-center gap-2">
                <code class="text-slate-400">{{ view.nodeId }}</code>
                <a
                  :href="view.url"
                  target="_blank"
                  rel="noreferrer"
                  class="text-indigo-300 hover:underline"
                >
                  open in Figma
                </a>
              </div>
              <div class="flex items-center gap-2">
                <code class="min-w-0 flex-1 truncate text-slate-500">{{ mcpFor(view.nodeId) }}</code>
                <UiButton size="sm" variant="ghost" @click="copy(mcpFor(view.nodeId), view.nodeId)">
                  {{ copied === view.nodeId ? 'Copied' : 'Copy MCP' }}
                </UiButton>
              </div>
            </div>
          </UiCard>
        </div>

        <div v-if="selectedScreen.componentIds.length">
          <UiSectionTitle title="Components on this screen" />
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button
              v-for="id in selectedScreen.componentIds"
              :key="id"
              class="rounded border border-white/10 bg-surface-raised px-2 py-1 font-mono text-xs text-slate-300 hover:border-white/30"
              @click="selection = { kind: 'component', id }"
            >
              {{ componentById.get(id)?.name ?? id }}
            </button>
          </div>
        </div>
      </div>

      <!-- One band of one screen: what a developer is about to build -->
      <div v-else-if="selectedSection" class="space-y-5">
        <header class="space-y-2">
          <button
            class="text-xs text-indigo-300 hover:underline"
            @click="selection = { kind: 'screen', id: selectedSection.screen.id }"
          >
            ← {{ selectedSection.screen.name }}
          </button>
          <h2 class="text-lg font-semibold">{{ selectedSection.section.name }}</h2>
          <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>block {{ selectedSection.section.order + 1 }}</span>
            <span>· {{ selectedSection.section.width ?? '?' }} × {{ selectedSection.section.height ?? '?' }}</span>
            <span>· {{ selectedSection.section.nodeCount }} layers</span>
            <a
              :href="selectedSection.section.url"
              target="_blank"
              rel="noreferrer"
              class="text-indigo-300 hover:underline"
            >
              open in Figma
            </a>
            <UiButton
              size="sm"
              variant="ghost"
              @click="copy(mcpFor(selectedSection.section.nodeId), selectedSection.section.nodeId)"
            >
              {{ copied === selectedSection.section.nodeId ? 'Copied' : 'Copy MCP' }}
            </UiButton>
          </div>
        </header>

        <p v-if="selectedSection.section.purpose" class="max-w-3xl text-sm text-slate-200">
          {{ selectedSection.section.purpose }}
        </p>

        <!-- Is it already somebody's component, or is it work? -->
        <UiCard class="space-y-3 p-4">
          <div v-if="selectedSection.section.componentName" class="flex flex-wrap items-center gap-2">
            <UiBadge tone="ok">already a component</UiBadge>
            <button
              class="font-mono text-sm text-slate-100 hover:underline"
              :disabled="!selectedSection.section.componentId"
              @click="
                selectedSection.section.componentId &&
                  (selection = { kind: 'component', id: selectedSection.section.componentId })
              "
            >
              {{ selectedSection.section.componentName }}
            </button>
          </div>
          <div v-else class="flex items-center gap-2">
            <UiBadge tone="warn">not a component</UiBadge>
            <span class="text-sm text-slate-400">
              This band is drawn on the page rather than placed from the library.
            </span>
          </div>

          <div v-if="selectedSection.section.componentIds.length">
            <p class="mb-1.5 text-xs uppercase tracking-wide text-slate-500">Built from</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="id in selectedSection.section.componentIds"
                :key="id"
                class="rounded border border-white/10 bg-surface-raised px-2 py-1 font-mono text-xs text-slate-300 hover:border-white/30"
                @click="selection = { kind: 'component', id }"
              >
                {{ componentById.get(id)?.name ?? id }}
              </button>
            </div>
          </div>
        </UiCard>

        <div class="grid gap-4 xl:grid-cols-2">
          <UiCard class="flex min-h-48 items-center justify-center p-3">
            <img
              v-if="shotUrl(selectedSection.section.shot)"
              :src="shotUrl(selectedSection.section.shot) ?? ''"
              :alt="selectedSection.section.name"
              class="max-h-[32rem] w-full rounded bg-white/5 object-contain"
            >
            <p v-else class="px-6 text-center text-xs text-slate-500">
              no render of this band — the screen's own render is on the screen page
            </p>
          </UiCard>

          <UiCard v-if="selectedSection.section.assets.length" class="space-y-2 p-4">
            <p class="text-xs uppercase tracking-wide text-slate-500">
              Assets needed ({{ selectedSection.section.assets.length }})
            </p>
            <ul class="space-y-1 text-sm">
              <li
                v-for="asset in selectedSection.section.assets"
                :key="asset.nodeId"
                class="flex items-baseline gap-2"
              >
                <UiBadge :tone="asset.kind === 'icon' ? 'neutral' : 'accent'">{{ asset.kind }}</UiBadge>
                <span class="min-w-0 flex-1 truncate text-slate-300">{{ asset.name }}</span>
                <span class="shrink-0 text-xs text-slate-500">
                  {{ asset.width ?? '?' }}×{{ asset.height ?? '?' }}
                </span>
                <a
                  :href="asset.url"
                  target="_blank"
                  rel="noreferrer"
                  class="shrink-0 text-xs text-indigo-300 hover:underline"
                >
                  open
                </a>
              </li>
            </ul>
          </UiCard>
          <UiCard v-else class="flex min-h-48 items-center justify-center p-4">
            <p class="text-xs text-slate-500">No images or icons in this band.</p>
          </UiCard>
        </div>

        <!-- What an author types -->
        <div v-if="selectedSection.section.fields.length">
          <UiSectionTitle title="What an author fills in" />
          <p v-if="selectedSection.section.authoring" class="mt-1 max-w-3xl text-sm text-slate-300">
            {{ selectedSection.section.authoring }}
          </p>

          <div class="mt-3 overflow-x-auto rounded border border-white/10">
            <table class="w-full text-left text-sm">
              <thead class="bg-white/5 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th class="px-3 py-2 font-medium">Field</th>
                  <th class="px-3 py-2 font-medium">Kind</th>
                  <th class="px-3 py-2 font-medium">In the design</th>
                  <th class="px-3 py-2 font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="field in selectedSection.section.fields"
                  :key="field.nodeId"
                  class="border-t border-white/5 align-top"
                >
                  <td class="px-3 py-2">
                    <span class="text-slate-100">{{ field.label ?? field.name }}</span>
                    <span v-if="field.repeated" class="ml-1.5 text-xs text-amber-400/80">repeats</span>
                    <span v-if="field.note" class="mt-0.5 block text-xs text-slate-500">
                      {{ field.note }}
                    </span>
                    <span
                      v-if="field.label && field.label !== field.name"
                      class="mt-0.5 block font-mono text-[11px] text-slate-600"
                    >
                      {{ field.name }}
                    </span>
                  </td>
                  <td class="px-3 py-2">
                    <UiBadge :tone="FIELD_TONE[field.kind] ?? 'neutral'">{{ field.kind }}</UiBadge>
                  </td>
                  <td class="max-w-xs px-3 py-2 text-slate-400">
                    <span v-if="field.sample" class="line-clamp-2">“{{ field.sample }}”</span>
                    <span v-else class="text-slate-600">—</span>
                  </td>
                  <td class="px-3 py-2 font-mono text-xs text-slate-500">
                    {{ field.componentName ?? 'the page' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- The bit that is nobody's component yet -->
        <div v-if="selectedSection.section.orphans.length">
          <UiSectionTitle title="Layers no component covers" />
          <p class="mt-1 max-w-3xl text-xs text-slate-500">
            Drawn straight onto the page rather than placed from the library. Each is either a
            component nobody has made yet, or content that belongs in one.
          </p>
          <ul class="mt-2 space-y-1 text-sm">
            <li
              v-for="orphan in selectedSection.section.orphans"
              :key="orphan.nodeId"
              class="flex items-baseline gap-2"
            >
              <span class="w-24 shrink-0 font-mono text-[11px] text-slate-600">{{ orphan.type }}</span>
              <span class="min-w-0 flex-1 truncate text-slate-300">{{ orphan.name }}</span>
              <span v-if="orphan.sample" class="min-w-0 flex-1 truncate text-xs text-slate-500">
                “{{ orphan.sample }}”
              </span>
            </li>
          </ul>
        </div>

        <!-- How it is authored in AEM -->
        <div v-if="ueJson">
          <div class="flex items-center gap-2">
            <UiSectionTitle :title="`Universal Editor model — ${ueFileName}`" />
            <UiButton size="sm" variant="ghost" class="ml-auto" @click="copy(ueJson, 'ue')">
              {{ copied === 'ue' ? 'Copied' : 'Copy' }}
            </UiButton>
          </div>
          <p class="mt-1 max-w-3xl text-xs text-slate-500">
            Assembled from the fields above, in the shape <code>aem-boilerplate-xwalk</code> takes.
            An image is two boxes because a reference with no alt text is a defect shipped by the
            model rather than by the author.
          </p>
          <pre
            class="mt-2 max-h-96 overflow-auto rounded border border-white/10 bg-surface-raised p-4 text-[11px] leading-relaxed text-slate-300"
          ><code>{{ ueJson }}</code></pre>
        </div>
      </div>

      <!-- One component -->
      <div v-else-if="selectedComponent" class="space-y-5">
        <header class="space-y-2">
          <h2 class="break-all font-mono text-lg font-semibold text-slate-100">
            {{ selectedComponent.name }}
          </h2>
          <div class="flex flex-wrap items-center gap-2">
            <UiBadge tone="neutral">{{ selectedComponent.type.toLowerCase().replace('_', ' ') }}</UiBadge>
            <UiBadge tone="ok">{{ selectedComponent.instances }} uses</UiBadge>
            <UiBadge :tone="selectedComponent.resolved ? 'accent' : 'warn'">
              {{ selectedComponent.resolved ? 'named by its main component' : 'named by an instance' }}
            </UiBadge>
            <UiBadge v-if="selectedComponent.moduleId" tone="neutral">
              {{ moduleById.get(selectedComponent.moduleId)?.name }}
            </UiBadge>
            <span v-if="selectedComponent.width" class="text-xs text-slate-500">
              {{ selectedComponent.width }} × {{ selectedComponent.height ?? '?' }}
            </span>
          </div>
        </header>

        <p v-if="selectedComponent.purpose" class="max-w-3xl text-sm text-slate-200">
          {{ selectedComponent.purpose }}
        </p>

        <div class="grid gap-4 xl:grid-cols-2">
          <UiCard class="flex min-h-48 items-center justify-center p-3">
            <img
              v-if="shotUrl(selectedComponent.shot)"
              :src="shotUrl(selectedComponent.shot) ?? ''"
              :alt="selectedComponent.name"
              class="max-h-96 w-full rounded bg-white/5 object-contain"
            >
            <p v-else class="px-6 text-center text-xs text-slate-500">
              not rendered — turn on component renders, or raise their budget
            </p>
          </UiCard>

          <UiCard v-if="selectedComponent.structure" class="space-y-2 p-4">
            <p class="text-xs uppercase tracking-wide text-slate-500">
              What is inside it
              <span v-if="selectedComponent.nodeCount" class="normal-case tracking-normal">
                — {{ selectedComponent.nodeCount }} layers
              </span>
            </p>
            <pre
              class="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-slate-400"
            ><code>{{ selectedComponent.structure }}</code></pre>
          </UiCard>
          <UiCard v-else class="flex min-h-48 items-center justify-center p-4">
            <p class="max-w-xs text-center text-xs text-slate-500">
              This component was never read. Its library is probably not open in the Figma session —
              open it and re-analyze.
            </p>
          </UiCard>
        </div>

        <div v-if="selectedComponent.text?.length">
          <UiSectionTitle title="The words it was drawn with" />
          <ul class="mt-2 space-y-0.5 text-sm text-slate-300">
            <li v-for="line in selectedComponent.text" :key="line" class="truncate">“{{ line }}”</li>
          </ul>
        </div>

        <div v-if="selectedComponent.uses?.length">
          <UiSectionTitle title="Built out of" />
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button
              v-for="name in selectedComponent.uses"
              :key="name"
              class="rounded border border-white/10 bg-surface-raised px-2 py-1 font-mono text-xs text-slate-300 hover:border-white/30 disabled:opacity-50"
              :disabled="!componentByName.get(name.toLowerCase())"
              @click="selectByName(name)"
            >
              {{ name }}
            </button>
          </div>
        </div>

        <UiCard class="space-y-2 p-4 text-sm">
          <div class="flex items-center gap-3">
            <span class="w-16 shrink-0 text-slate-500">Node</span>
            <code class="text-slate-300">{{ selectedComponent.nodeId }}</code>
            <a
              :href="selectedComponent.url"
              target="_blank"
              rel="noreferrer"
              class="text-xs text-indigo-300 hover:underline"
            >
              open in Figma
            </a>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-16 shrink-0 text-slate-500">MCP</span>
            <code class="min-w-0 flex-1 truncate text-xs text-slate-400">
              {{ mcpFor(selectedComponent.nodeId) }}
            </code>
            <UiButton
              size="sm"
              variant="ghost"
              @click="copy(mcpFor(selectedComponent.nodeId), selectedComponent.id)"
            >
              {{ copied === selectedComponent.id ? 'Copied' : 'Copy' }}
            </UiButton>
          </div>
          <div class="flex items-start gap-3">
            <span class="w-16 shrink-0 text-slate-500">Name</span>
            <code class="min-w-0 flex-1 break-all text-xs text-slate-400">{{ selectedComponent.name }}</code>
            <UiButton
              size="sm"
              variant="ghost"
              @click="copy(selectedComponent.name, `n-${selectedComponent.id}`)"
            >
              {{ copied === `n-${selectedComponent.id}` ? 'Copied' : 'Copy' }}
            </UiButton>
          </div>
        </UiCard>

        <div v-if="selectedComponent.variants.length">
          <UiSectionTitle title="Variants seen" />
          <ul class="mt-2 space-y-0.5 font-mono text-xs text-slate-400">
            <li v-for="variant in selectedComponent.variants" :key="variant">{{ variant }}</li>
          </ul>
        </div>

        <div v-if="selectedComponent.screenIds.length">
          <UiSectionTitle title="Used on" />
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button
              v-for="id in selectedComponent.screenIds"
              :key="id"
              class="rounded border border-white/10 bg-surface-raised px-2 py-1 text-xs text-slate-300 hover:border-white/30"
              @click="selection = { kind: 'screen', id }"
            >
              {{ screenById.get(id)?.name ?? id }}
            </button>
          </div>
        </div>
      </div>

      <!-- One module -->
      <div v-else-if="selectedModule" class="space-y-5">
        <header class="flex flex-wrap items-center gap-3">
          <h2 class="text-lg font-semibold">{{ selectedModule.name }}</h2>
          <UiBadge tone="neutral">{{ selectedModule.componentIds.length }} components</UiBadge>
          <UiBadge tone="neutral">{{ selectedModule.screenIds.length }} screens</UiBadge>
        </header>

        <p v-if="selectedModule.summary" class="max-w-3xl text-sm text-slate-200">
          {{ selectedModule.summary }}
        </p>

        <UiSectionTitle title="Components" />
        <ul class="space-y-1">
          <li v-for="id in selectedModule.componentIds" :key="id">
            <button
              class="flex w-full items-baseline gap-3 rounded px-2 py-1 text-left hover:bg-white/5"
              @click="selection = { kind: 'component', id }"
            >
              <code class="min-w-0 flex-1 truncate text-sm text-slate-200">
                {{ componentById.get(id)?.name }}
              </code>
              <span class="shrink-0 text-xs text-slate-500">
                {{ componentById.get(id)?.instances }} uses
              </span>
            </button>
            <p v-if="componentById.get(id)?.purpose" class="px-2 pb-1 text-xs text-slate-500">
              {{ componentById.get(id)?.purpose }}
            </p>
          </li>
        </ul>
      </div>

      <div v-else class="pt-16 text-center text-sm text-slate-500">Pick something from the index.</div>
    </section>
  </div>
</template>
