<script setup lang="ts">
/**
 * The library: folders and filters on the left, cards in the middle, details on
 * the right, and a preview over the top of all three.
 *
 * Folder, pack, selection and both filters live in the query string. That is
 * what makes a particular clip -- or a particular view of the library -- some-
 * thing you can send to someone or come back to, and it is the reason this is a
 * page rather than a modal over the console.
 */
import { computed, ref, watch } from 'vue';

import {
  entryItems,
  facetsOf,
  featureOf,
  filterMedia,
  formatBytes,
  groupLabel,
  groupMedia,
  isImageSettings,
  shortDescription,
  sourceLabel,
  sourceOf,
  stackMedia,
  FEATURE_LABELS,
  type ArmFeature,
  type MediaEntry,
  type MediaItem,
} from '#shared/library';

import MediaDetail from '../components/MediaDetail.vue';
import MediaLightbox from '../components/MediaLightbox.vue';
import MediaThumb from '../components/MediaThumb.vue';
import UiButton from '../components/ui/Button.vue';
import UiField from '../components/ui/Field.vue';
import UiSelect from '../components/ui/Select.vue';

useHead({ title: 'Library' });

const route = useRoute();
const router = useRouter();
const { items, byId, pending, refresh } = useMedia();

const ALL = 'all';

/** A query value that is a single string, or `all` for anything else. */
function queryValue(key: string): string {
  const value = route.query[key];
  return typeof value === 'string' && value !== '' ? value : ALL;
}

const feature = computed(() => queryValue('feature'));
const source = computed(() => queryValue('source'));

/**
 * The facets are counted over everything, not over what the other filter left.
 *
 * Two filters that narrow each other's options make a dead end: pick an arm,
 * then find the only feature it can do is the one already chosen. Counting over
 * the whole library keeps every combination reachable, and a combination with
 * nothing in it says so in the grid.
 */
const featureFacets = computed(() =>
  facetsOf(items.value, featureOf, (value) => FEATURE_LABELS[value as ArmFeature] ?? value),
);
const sourceFacets = computed(() => facetsOf(items.value, sourceOf, sourceLabel));

const featureOptions = computed(() => [
  { value: ALL, label: `Everything (${items.value.length})` },
  ...featureFacets.value.map((facet) => ({ value: facet.value, label: `${facet.label} (${facet.count})` })),
]);

const sourceOptions = computed(() => [
  { value: ALL, label: `Every arm (${items.value.length})` },
  ...sourceFacets.value.map((facet) => ({ value: facet.value, label: `${facet.label} (${facet.count})` })),
]);

const filtered = computed(() => filterMedia(items.value, { feature: feature.value, source: source.value }));
const groups = computed(() => groupMedia(filtered.value));

/** The folder in the URL if the filters left anything in it, otherwise the newest. */
const folder = computed(() => {
  const wanted = route.query['folder'];
  if (wanted === ALL) return ALL;
  if (typeof wanted === 'string' && groups.value.some((group) => group.group === wanted)) return wanted;
  return groups.value[0]?.group ?? ALL;
});

const inFolder = computed<MediaItem[]>(() => {
  if (folder.value === ALL) return groups.value.flatMap((group) => group.items);
  return groups.value.find((group) => group.group === folder.value)?.items ?? [];
});

/** The folder's contents, with each batch collapsed into one card. */
const entries = computed<MediaEntry[]>(() => stackMedia(inFolder.value));

/**
 * The pack being looked inside, if the URL names one that is still there.
 *
 * A pack is a folder made of a job rather than of a directory, so it is opened
 * the same way a folder is: the grid becomes its contents and the back button
 * leaves it. Nothing is layered over the library, because a pack is a place in
 * it and not a thing on top of it.
 */
const pack = computed<MediaEntry | null>(() => {
  const wanted = route.query['pack'];
  if (typeof wanted !== 'string') return null;
  return entries.value.find((entry) => entry.kind === 'stack' && entry.key === wanted) ?? null;
});

/** What the grid draws: the folder's cards, or the open pack's files. */
const cards = computed<MediaEntry[]>(() =>
  pack.value?.kind === 'stack'
    ? pack.value.items.map((item) => ({ kind: 'item' as const, key: item.id, item }))
    : entries.value,
);

const visible = computed<MediaItem[]>(() => entryItems(cards.value));

/** What the job asked for, which is not always how many files survive. */
const packAsked = computed(() => {
  const settings = pack.value?.kind === 'stack' ? pack.value.cover.meta?.settings : undefined;
  return isImageSettings(settings) ? settings.batch : null;
});

const selected = computed<MediaItem | null>(() => {
  const wanted = route.query['item'];
  return typeof wanted === 'string' ? (byId.value.get(wanted) ?? null) : null;
});

const preview = ref<MediaItem | null>(null);

/** Filters, folder and pack travel together: changing one must not drop the others. */
function navigate(patch: Record<string, string | undefined>, push = true): void {
  const query = { ...route.query, ...patch };
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === ALL) delete query[key];
  }
  void (push ? router.push({ query }) : router.replace({ query }));
}

/** Leaving a folder leaves whatever pack was open inside it. */
function openFolder(next: string): void {
  navigate({ folder: next, pack: undefined, item: undefined });
}

/** A filter change drops the selection and the pack: both may have been filtered out. */
function setFilter(key: 'feature' | 'source', value: string): void {
  navigate({ [key]: value, folder: undefined, pack: undefined, item: undefined });
}

/** Selection replaces rather than pushes: clicking through a folder is looking,
 * not navigating, and it should not fill the back button. */
function select(item: MediaItem): void {
  navigate({ item: item.id }, false);
}

/** Preview follows selection, so arrowing through the lightbox moves both. */
function show(item: MediaItem): void {
  select(item);
  preview.value = item;
}

/** Jump to a file that is not in the folder being looked at, such as a reference. */
function reveal(item: MediaItem): void {
  navigate({ folder: item.group, pack: undefined, item: item.id });
}

/**
 * A card is either a file or a pack. Opening a pack pushes, so the browser's
 * back button steps out of it the way it steps out of a folder.
 */
function activate(entry: MediaEntry): void {
  if (entry.kind === 'item') select(entry.item);
  else navigate({ pack: entry.key, item: undefined });
}

function closePack(): void {
  navigate({ pack: undefined });
}

const reference = computed(() => {
  const id = selected.value?.meta?.referenceId;
  return id ? (byId.value.get(id) ?? null) : null;
});

// A file that has gone away -- deleted outside the studio, or a stale link --
// should not leave the viewer showing something that is not there.
watch(byId, (index) => {
  if (preview.value && !index.has(preview.value.id)) preview.value = null;
});

// A pack the filters (or a deletion) took away leaves its name in the URL.
// Dropping it there keeps the address honest about what is on screen.
watch(
  [() => route.query['pack'], pack],
  ([wanted, open]) => {
    if (typeof wanted === 'string' && open === null) navigate({ pack: undefined }, false);
  },
  { flush: 'post' },
);

const totalBytes = computed(() => visible.value.reduce((sum, item) => sum + item.bytes, 0));
const packCount = computed(() => entries.value.filter((entry) => entry.kind === 'stack').length);
</script>

<template>
  <div class="flex h-full">
    <aside class="w-64 shrink-0 space-y-4 overflow-y-auto border-r border-white/10 p-4">
      <div class="flex items-center justify-between">
        <h1 class="text-sm font-semibold uppercase tracking-wide text-slate-500">Library</h1>
        <UiButton size="sm" variant="ghost" :disabled="pending" @click="refresh()">Refresh</UiButton>
      </div>

      <div class="space-y-2">
        <UiField label="Feature" for="filter-feature">
          <UiSelect
            id="filter-feature"
            :model-value="feature"
            :options="featureOptions"
            data-testid="filter-feature"
            @update:model-value="setFilter('feature', $event)"
          />
        </UiField>
        <UiField label="Arm" for="filter-source">
          <UiSelect
            id="filter-source"
            :model-value="source"
            :options="sourceOptions"
            data-testid="filter-source"
            @update:model-value="setFilter('source', $event)"
          />
        </UiField>
      </div>

      <div>
        <h2 class="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">Folders</h2>
        <nav class="space-y-0.5">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors"
            :class="folder === ALL ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5'"
            @click="openFolder(ALL)"
          >
            <span>All media</span>
            <span class="text-xs text-slate-500">{{ filtered.length }}</span>
          </button>

          <template v-for="group in groups" :key="group.group">
            <button
              type="button"
              :data-testid="`folder-${group.group}`"
              class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors"
              :class="folder === group.group ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5'"
              @click="openFolder(group.group)"
            >
              <span class="min-w-0 flex-1 truncate">
                {{ groupLabel(group.group) }}
                <span class="block truncate text-[10px] text-slate-600">{{ group.group }}</span>
              </span>
              <span class="text-xs text-slate-500">{{ group.items.length }}</span>
            </button>

            <!-- The open pack sits under its folder, indented: it is a place
                 inside that folder, and the tree should say so. -->
            <button
              v-if="pack?.kind === 'stack' && folder === group.group"
              type="button"
              class="flex w-full items-center justify-between gap-2 rounded bg-white/10 py-1.5 pl-6 pr-2 text-left text-sm text-slate-100"
              @click="closePack()"
            >
              <span class="min-w-0 flex-1 truncate">&#9707; Batch</span>
              <span class="text-xs text-slate-500">{{ pack.items.length }}</span>
            </button>
          </template>
        </nav>
      </div>

      <p v-if="groups.length === 0" class="text-sm text-slate-500">
        {{
          items.length === 0
            ? 'Nothing in storage yet. Generated clips and uploads both appear here.'
            : 'Nothing matches these filters.'
        }}
      </p>
    </aside>

    <section class="min-w-0 flex-1 overflow-y-auto p-6">
      <header class="mb-4 flex items-baseline justify-between gap-4">
        <div class="flex min-w-0 items-baseline gap-2">
          <template v-if="pack">
            <button
              type="button"
              data-testid="leave-pack"
              class="shrink-0 rounded px-1 text-lg font-semibold text-slate-400 hover:bg-white/5 hover:text-slate-100"
              aria-label="Back to the folder"
              @click="closePack()"
            >
              &#8592;
            </button>
            <button
              type="button"
              class="truncate text-lg font-semibold text-slate-400 hover:text-slate-100"
              @click="closePack()"
            >
              {{ folder === ALL ? 'All media' : groupLabel(folder) }}
            </button>
            <span class="text-lg text-slate-600">/</span>
            <h2 class="truncate text-lg font-semibold">Batch of {{ visible.length }}</h2>
          </template>
          <h2 v-else class="truncate text-lg font-semibold">
            {{ folder === ALL ? 'All media' : groupLabel(folder) }}
          </h2>
        </div>

        <p class="shrink-0 text-xs text-slate-500">
          <template v-if="pack">
            <span v-if="packAsked !== null && packAsked !== visible.length">
              {{ visible.length }} of {{ packAsked }} still here ·
            </span>
            <span v-else>one job · </span>
          </template>
          <template v-else>
            {{ visible.length }} item{{ visible.length === 1 ? '' : 's' }}
            <span v-if="packCount > 0">in {{ cards.length }} cards</span>
            ·
          </template>
          {{ formatBytes(totalBytes) }}
        </p>
      </header>

      <p v-if="pack" class="mb-3 truncate text-xs text-slate-500">
        {{ pack.kind === 'stack' ? (pack.cover.meta?.prompt ?? pack.cover.group) : '' }}
      </p>

      <ul class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        <li v-for="(entry, position) in cards" :key="entry.key" class="relative">
          <!-- A pack's two offset layers are the card saying there is more than
               one picture behind it, before any count is read. -->
          <template v-if="entry.kind === 'stack'">
            <span
              class="pointer-events-none absolute inset-x-3 -top-1.5 h-3 rounded-t border border-b-0 border-white/10 bg-surface-raised"
            />
            <span
              class="pointer-events-none absolute inset-x-1.5 -top-0.5 h-3 rounded-t border border-b-0 border-white/15 bg-surface-raised"
            />
          </template>

          <button
            type="button"
            :data-testid="entry.kind === 'stack' ? `stack-${entry.key}` : `media-${entry.item.id}`"
            class="relative w-full overflow-hidden rounded-lg border text-left transition-colors"
            :class="
              (
                entry.kind === 'stack'
                  ? entry.items.some((item) => item.id === selected?.id)
                  : selected?.id === entry.item.id
              )
                ? 'border-indigo-400'
                : 'border-white/10 hover:border-white/30'
            "
            @click="activate(entry)"
            @dblclick="entry.kind === 'item' ? show(entry.item) : undefined"
          >
            <div class="aspect-video">
              <MediaThumb :item="entry.kind === 'stack' ? entry.cover : entry.item" kind-badge />
            </div>
            <span
              v-if="entry.kind === 'stack'"
              class="absolute right-1 top-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-slate-100"
            >
              &#9707; {{ entry.items.length }}
            </span>
            <!-- Inside a pack the position is worth more than the filename: the
                 files differ by one digit and by the seed they were made from. -->
            <span
              v-else-if="pack"
              class="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-none text-slate-300"
            >
              {{ position + 1 }}
            </span>
            <div class="space-y-0.5 p-2">
              <p class="truncate text-xs font-medium text-slate-200">
                {{ entry.kind === 'stack' ? `Batch of ${entry.items.length}` : entry.item.name }}
              </p>
              <p class="truncate text-[11px] text-slate-500">
                {{ shortDescription(entry.kind === 'stack' ? entry.cover : entry.item) }}
              </p>
            </div>
          </button>
        </li>
      </ul>

      <p v-if="cards.length === 0" class="text-sm text-slate-500">
        {{ items.length === 0 ? 'This folder is empty.' : 'Nothing here matches these filters.' }}
      </p>
    </section>

    <aside
      v-if="selected"
      class="w-80 shrink-0 overflow-hidden border-l border-white/10 p-4"
      data-testid="detail-panel"
    >
      <MediaDetail :item="selected" :reference="reference" @preview="show" @open-reference="reveal" />
    </aside>

    <!-- Inside a pack the arrow keys stay in that pack, because `visible` is
         what the grid is showing and nothing else. -->
    <MediaLightbox :item="preview" :items="visible" @close="preview = null" @navigate="show" />
  </div>
</template>
