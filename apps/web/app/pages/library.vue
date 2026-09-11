<script setup lang="ts">
/**
 * The library: folders on the left, thumbnails in the middle, details on the
 * right, and a preview over the top of all three.
 *
 * Folder and selection both live in the query string. That is what makes a
 * particular clip something you can send to someone or come back to, and it is
 * the reason this is a page rather than a modal over the console.
 */
import { computed, ref, watch } from 'vue';

import { formatBytes, groupLabel, shortDescription, type MediaItem } from '#shared/library';

import MediaDetail from '../components/MediaDetail.vue';
import MediaLightbox from '../components/MediaLightbox.vue';
import MediaThumb from '../components/MediaThumb.vue';
import UiButton from '../components/ui/Button.vue';

useHead({ title: 'Library' });

const route = useRoute();
const router = useRouter();
const { items, groups, byId, pending, refresh } = useMedia();

const ALL = 'all';

/** The folder in the URL if it still exists, otherwise the newest one. */
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

const selected = computed<MediaItem | null>(() => {
  const wanted = route.query['item'];
  return typeof wanted === 'string' ? (byId.value.get(wanted) ?? null) : null;
});

const preview = ref<MediaItem | null>(null);

function openFolder(next: string): void {
  void router.push({ query: { folder: next } });
}

/** Selection replaces rather than pushes: clicking through a folder is looking,
 * not navigating, and it should not fill the back button. */
function select(item: MediaItem): void {
  void router.replace({ query: { folder: item.group, item: item.id } });
}

/** Preview follows selection, so arrowing through the lightbox moves both. */
function show(item: MediaItem): void {
  select(item);
  preview.value = item;
}

/** Jump to a file that is not in the folder being looked at, such as a reference. */
function reveal(item: MediaItem): void {
  void router.push({ query: { folder: item.group, item: item.id } });
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

const totalBytes = computed(() => visible.value.reduce((sum, item) => sum + item.bytes, 0));
</script>

<template>
  <div class="flex h-full">
    <aside class="w-64 shrink-0 space-y-4 overflow-y-auto border-r border-white/10 p-4">
      <div class="flex items-center justify-between">
        <h1 class="text-sm font-semibold uppercase tracking-wide text-slate-500">Folders</h1>
        <UiButton size="sm" variant="ghost" :disabled="pending" @click="refresh()">Refresh</UiButton>
      </div>

      <nav class="space-y-0.5">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors"
          :class="folder === ALL ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5'"
          @click="openFolder(ALL)"
        >
          <span>All media</span>
          <span class="text-xs text-slate-500">{{ items.length }}</span>
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

      <p v-if="groups.length === 0" class="text-sm text-slate-500">
        Nothing in storage yet. Generated clips and uploads both appear here.
      </p>
    </aside>

    <section class="min-w-0 flex-1 overflow-y-auto p-6">
      <header class="mb-4 flex items-baseline justify-between gap-4">
        <h2 class="text-lg font-semibold">
          {{ folder === ALL ? 'All media' : groupLabel(folder) }}
        </h2>
        <p class="text-xs text-slate-500">
          {{ visible.length }} item{{ visible.length === 1 ? '' : 's' }} · {{ formatBytes(totalBytes) }}
        </p>
      </header>

      <ul class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        <li v-for="item in visible" :key="item.id">
          <button
            type="button"
            :data-testid="`media-${item.id}`"
            class="w-full overflow-hidden rounded-lg border text-left transition-colors"
            :class="
              selected?.id === item.id ? 'border-indigo-400' : 'border-white/10 hover:border-white/30'
            "
            @click="select(item)"
            @dblclick="show(item)"
          >
            <div class="aspect-video"><MediaThumb :item="item" /></div>
            <div class="space-y-0.5 p-2">
              <p class="truncate text-xs font-medium text-slate-200">{{ item.name }}</p>
              <p class="truncate text-[11px] text-slate-500">{{ shortDescription(item) }}</p>
            </div>
          </button>
        </li>
      </ul>

      <p v-if="visible.length === 0" class="text-sm text-slate-500">This folder is empty.</p>
    </section>

    <aside
      v-if="selected"
      class="w-80 shrink-0 overflow-hidden border-l border-white/10 p-4"
      data-testid="detail-panel"
    >
      <MediaDetail
        :item="selected"
        :reference="reference"
        @preview="show"
        @open-reference="reveal"
      />
    </aside>

    <MediaLightbox :item="preview" :items="visible" @close="preview = null" @navigate="show" />
  </div>
</template>
