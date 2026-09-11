<script setup lang="ts">
/**
 * The library: folders and filters on the left, cards in the middle, details on
 * the right, and a preview over the top of all three.
 *
 * Folder, selection and both filters live in the query string. That is what
 * makes a particular clip -- or a particular view of the library -- something
 * you can send to someone or come back to, and it is the reason this is a page
 * rather than a modal over the console.
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
import MediaStackWindow from '../components/MediaStackWindow.vue';
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

const visible = computed<MediaItem[]>(() => {
  if (folder.value === ALL) return groups.value.flatMap((group) => group.items);
  return groups.value.find((group) => group.group === folder.value)?.items ?? [];
});

/** What the grid draws: files, with each batch collapsed into one card. */
const entries = computed<MediaEntry[]>(() => stackMedia(visible.value));

const selected = computed<MediaItem | null>(() => {
  const wanted = route.query['item'];
  return typeof wanted === 'string' ? (byId.value.get(wanted) ?? null) : null;
});

const preview = ref<MediaItem | null>(null);
const openStack = ref<MediaEntry | null>(null);

/** Inside an open batch the arrow keys stay in that batch; otherwise they cross the folder. */
const lightboxItems = computed<MediaItem[]>(() =>
  openStack.value?.kind === 'stack' ? openStack.value.items : entryItems(entries.value),
);

/** Filters and folder travel together: changing one must not drop the others. */
function navigate(patch: Record<string, string | undefined>, push = true): void {
  const query = { ...route.query, ...patch };
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === ALL) delete query[key];
  }
  void (push ? router.push({ query }) : router.replace({ query }));
}

function openFolder(next: string): void {
  navigate({ folder: next, item: undefined });
}

/** A filter change drops the selected item: it may well have been filtered out. */
function setFilter(key: 'feature' | 'source', value: string): void {
  navigate({ [key]: value, folder: undefined, item: undefined });
}

/** Selection replaces rather than pushes: clicking through a folder is looking,
 * not navigating, and it should not fill the back button. */
function select(item: MediaItem): void {
  navigate({ folder: item.group, item: item.id }, false);
}

/** Preview follows selection, so arrowing through the lightbox moves both. */
function show(item: MediaItem): void {
  select(item);
  preview.value = item;
}

/** Jump to a file that is not in the folder being looked at, such as a reference. */
function reveal(item: MediaItem): void {
  navigate({ folder: item.group, item: item.id });
}

/** A card is either a file or a batch, and a batch opens rather than previews. */
function activate(entry: MediaEntry): void {
  if (entry.kind === 'item') {
    select(entry.item);
    return;
  }
  openStack.value = entry;
  select(entry.cover);
}

const reference = computed(() => {
  const id = selected.value?.meta?.referenceId;
  return id ? (byId.value.get(id) ?? null) : null;
});

// A file that has gone away -- deleted outside the studio, or a stale link --
// should not leave the viewer showing something that is not there.
watch(byId, (index) => {
  if (preview.value && !index.has(preview.value.id)) preview.value = null;
  if (openStack.value?.kind === 'stack' && !openStack.value.items.every((item) => index.has(item.id))) {
    openStack.value = null;
  }
});

// A filter that hides the open batch should close it, rather than leave a window
// over a library that no longer contains it.
watch(entries, (list) => {
  const key = openStack.value?.key;
  if (key !== undefined && !list.some((entry) => entry.key === key)) openStack.value = null;
});

const totalBytes = computed(() => visible.value.reduce((sum, item) => sum + item.bytes, 0));
const stackCount = computed(() => entries.value.filter((entry) => entry.kind === 'stack').length);
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

          <button
            v-for="group in groups"
            :key="group.group"
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
        <h2 class="text-lg font-semibold">
          {{ folder === ALL ? 'All media' : groupLabel(folder) }}
        </h2>
        <p class="text-xs text-slate-500">
          {{ visible.length }} item{{ visible.length === 1 ? '' : 's' }}
          <span v-if="stackCount > 0">in {{ entries.length }} cards</span>
          · {{ formatBytes(totalBytes) }}
        </p>
      </header>

      <ul class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        <li v-for="entry in entries" :key="entry.key" class="relative">
          <!-- The stack's two offset layers are the card saying there is more
               than one picture behind it, before any count is read. -->
          <template v-if="entry.kind === 'stack'">
            <span class="pointer-events-none absolute inset-x-3 -top-1.5 h-3 rounded-t border border-b-0 border-white/10 bg-surface-raised" />
            <span class="pointer-events-none absolute inset-x-1.5 -top-0.5 h-3 rounded-t border border-b-0 border-white/15 bg-surface-raised" />
          </template>

          <button
            type="button"
            :data-testid="entry.kind === 'stack' ? `stack-${entry.key}` : `media-${entry.item.id}`"
            class="relative w-full overflow-hidden rounded-lg border text-left transition-colors"
            :class="
              (entry.kind === 'stack' ? entry.items.some((item) => item.id === selected?.id) : selected?.id === entry.item.id)
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

      <p v-if="entries.length === 0" class="text-sm text-slate-500">
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

    <MediaStackWindow
      :items="openStack?.kind === 'stack' ? openStack.items : null"
      :selected-id="selected?.id"
      @close="openStack = null"
      @select="select"
      @preview="show"
    />

    <MediaLightbox :item="preview" :items="lightboxItems" @close="preview = null" @navigate="show" />
  </div>
</template>
