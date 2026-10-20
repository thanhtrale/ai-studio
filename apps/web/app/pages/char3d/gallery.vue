<script setup lang="ts">
/**
 * The 3D gallery, laid out like Mixamo: the rigged characters the person added
 * (the "Add to 3D gallery" button on a finished rig run) on the left, the clip
 * library as a grid of animated cards in the middle, and the selected clip
 * playing on the selected character on the right (`AnimViewer`).
 *
 * The selection is in the URL (`?c=<entry>&a=<clip>`), so a link opens the
 * same pair. The library is built by the rig arm's `scripts/cliplib.py` into
 * `storage/models/rig/mixamo-lib/`; until then the grid says so.
 */
import { computed, ref, watch } from 'vue';

import type { Char3dClipLibrary, Char3dReviewEntry } from '#shared/char3d';

import AnimViewer from '../../components/char3d/AnimViewer.vue';
import UiButton from '../../components/ui/Button.vue';
import UiInput from '../../components/ui/Input.vue';

useHead({ title: '3D gallery' });

const route = useRoute();
const router = useRouter();

const { data: savedData, refresh: refreshSaved } = await useFetch<{ saved: Char3dReviewEntry[] }>('/api/char3d-review');
const { data: library } = await useFetch<Char3dClipLibrary>('/api/char3d-review/clips');

const selected = ref(String(route.query['c'] ?? ''));
const clipId = ref(String(route.query['a'] ?? ''));

const saved = computed(() => savedData.value?.saved ?? []);
const current = computed(() => saved.value.find((entry) => entry.id === selected.value));
if (!current.value && saved.value[0]) selected.value = saved.value[0].id;

const fileUrl = (entry: Char3dReviewEntry, rel: string): string => `/api/char3d/${entry.character}/file/${rel}`;
const modelUrl = computed(() =>
  current.value && !current.value.missing ? fileUrl(current.value, current.value.model) : undefined,
);
const clipUrl = computed(() => (clipId.value ? `/api/char3d-review/clips/${clipId.value}/clip` : undefined));

async function remove(entry: Char3dReviewEntry): Promise<void> {
  if (!confirm(`Remove "${entry.name}" from the 3D gallery? The rig run itself is kept.`)) return;
  await $fetch(`/api/char3d-review/${entry.id}`, { method: 'DELETE' });
  if (selected.value === entry.id) selected.value = '';
  await refreshSaved();
}

// --- filtering the clips ------------------------------------------------------------
const query = ref('');
const tags = ref<string[]>([]);
const showTags = ref(false);
const LIMIT_STEP = 120;
const limit = ref(LIMIT_STEP);

const clips = computed(() => library.value?.clips ?? []);
const tagCount = computed(() => {
  const counts: Record<string, number> = {};
  for (const clip of clips.value) for (const tag of clip.tags) counts[tag] = (counts[tag] ?? 0) + 1;
  return counts;
});
const groups = computed(() => {
  const groupOf = library.value?.tagGroups ?? {};
  const order = library.value?.groupOrder ?? [];
  const out: { group: string; tags: string[] }[] = [];
  for (const group of order) {
    const inGroup = Object.keys(tagCount.value)
      .filter((tag) => (groupOf[tag] ?? 'other') === group)
      .sort((a, b) => (tagCount.value[b] ?? 0) - (tagCount.value[a] ?? 0));
    if (inGroup.length) out.push({ group, tags: inGroup });
  }
  const rest = Object.keys(tagCount.value).filter((tag) => !order.includes(groupOf[tag] ?? 'other'));
  if (rest.length) out.push({ group: 'other', tags: rest });
  return out;
});
// One primary category per clip (cliplib.py), picked one at a time; tags and search narrow further.
const category = ref(String(route.query['cat'] ?? ''));
const categoryCount = computed(() => {
  const counts: Record<string, number> = {};
  for (const clip of clips.value) {
    const key = clip.category ?? 'other';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
});
const filtered = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  return clips.value
    .filter((clip) => !category.value || (clip.category ?? 'other') === category.value)
    .filter((clip) => tags.value.every((tag) => clip.tags.includes(tag)))
    .filter((clip) => {
      if (!words.length) return true;
      const haystack = `${clip.name} ${clip.description ?? ''} ${clip.tags.join(' ')}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
});
watch([query, tags, category], () => (limit.value = LIMIT_STEP), { deep: true });

function toggleTag(tag: string): void {
  tags.value = tags.value.includes(tag) ? tags.value.filter((other) => other !== tag) : [...tags.value, tag];
}
const currentClip = computed(() => clips.value.find((clip) => clip.id === clipId.value));

watch([selected, clipId, category], ([c, a, cat]) =>
  void router.replace({ query: { ...(c ? { c } : {}), ...(a ? { a } : {}), ...(cat ? { cat } : {}) } }),
);
</script>

<template>
  <div class="flex h-full">
    <!-- saved characters -->
    <aside class="w-60 shrink-0 space-y-2 overflow-y-auto border-r border-white/10 p-3">
      <NuxtLink to="/char3d" class="text-sm text-slate-400 hover:text-slate-100">← 3D</NuxtLink>
      <p class="text-sm font-medium">Characters ({{ saved.length }})</p>
      <p v-if="!saved.length" class="text-sm text-slate-500">
        The gallery is empty. Open a good rig run of a character and press "Add to 3D gallery".
      </p>
      <div
        v-for="entry in saved"
        :key="entry.id"
        class="group flex cursor-pointer gap-2 rounded border p-1.5 transition-colors"
        :class="entry.id === selected ? 'border-indigo-400/70 bg-white/5' : 'border-white/10 hover:border-white/30'"
        role="button"
        tabindex="0"
        @click="selected = entry.id"
        @keydown.enter="selected = entry.id"
      >
        <img
          v-if="entry.thumb"
          :src="fileUrl(entry, entry.thumb)"
          alt=""
          class="h-16 w-14 shrink-0 rounded bg-white object-contain"
          loading="lazy"
        />
        <span class="min-w-0 flex-1 space-y-0.5">
          <span class="line-clamp-2 block text-sm text-slate-100">{{ entry.name }}</span>
          <NuxtLink
            :to="`/char3d/${entry.character}?tab=rig&run=${entry.run}`"
            class="block truncate text-xs text-slate-500 hover:text-slate-200"
            @click.stop
          >
            {{ entry.run }}
          </NuxtLink>
          <span v-if="entry.missing" class="block text-xs text-rose-300">model file missing</span>
        </span>
        <button
          type="button"
          class="self-start text-xs text-slate-500 opacity-0 hover:text-rose-300 group-hover:opacity-100"
          title="Remove from the 3D gallery"
          aria-label="Remove from the 3D gallery"
          @click.stop="remove(entry)"
        >
          ✕
        </button>
      </div>
    </aside>

    <!-- the clip library -->
    <main class="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-xl font-semibold">Animations</h1>
        <span class="text-sm text-slate-500">{{ filtered.length }} / {{ clips.length }}</span>
        <span class="flex-1" />
        <div class="w-72 max-w-full"><UiInput v-model="query" placeholder="Search animations" /></div>
        <UiButton size="sm" :active="showTags || tags.length > 0" @click="showTags = !showTags">
          Filters{{ tags.length ? ` (${tags.length})` : '' }}
        </UiButton>
        <UiButton
          v-if="tags.length || query || category"
          size="sm"
          variant="ghost"
          @click="
            tags = [];
            query = '';
            category = '';
          "
        >
          Clear
        </UiButton>
      </div>
      <div v-if="clips.length" class="flex flex-wrap gap-1" role="tablist" aria-label="Category">
        <button
          type="button"
          class="rounded px-2.5 py-1 text-xs"
          :class="!category ? 'bg-indigo-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'"
          @click="category = ''"
        >
          All <span class="opacity-60">{{ clips.length }}</span>
        </button>
        <button
          v-for="[name, count] in categoryCount"
          :key="name"
          type="button"
          class="rounded px-2.5 py-1 text-xs capitalize"
          :class="category === name ? 'bg-indigo-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'"
          @click="category = category === name ? '' : name"
        >
          {{ name }} <span class="opacity-60">{{ count }}</span>
        </button>
      </div>
      <div v-if="tags.length && !showTags" class="flex flex-wrap gap-1">
        <button
          v-for="tag in tags"
          :key="tag"
          type="button"
          class="rounded-full bg-indigo-500 px-2 py-0.5 text-xs text-white"
          @click="toggleTag(tag)"
        >
          {{ tag }} ×
        </button>
      </div>
      <div v-if="showTags" class="max-h-48 space-y-1.5 overflow-y-auto rounded border border-white/10 p-2">
        <div v-for="group in groups" :key="group.group" class="flex flex-wrap items-center gap-1">
          <span class="w-20 shrink-0 text-xs uppercase text-slate-500">{{ group.group }}</span>
          <button
            v-for="tag in group.tags"
            :key="tag"
            type="button"
            class="rounded-full border px-2 py-0.5 text-xs"
            :class="tags.includes(tag) ? 'border-indigo-400 bg-indigo-500 text-white' : 'border-white/15 text-slate-300 hover:border-indigo-400'"
            @click="toggleTag(tag)"
          >
            {{ tag }} <span class="opacity-60">{{ tagCount[tag] }}</span>
          </button>
        </div>
      </div>

      <p v-if="!clips.length" class="text-sm text-slate-500">
        The clip library is empty. It is filled from Mixamo by the rig arm's <code>scripts/mixamo_fetch.py</code> and
        <code>scripts/cliplib.py</code> (see its README); until then only the rest pose can be shown.
      </p>

      <div class="flex flex-wrap gap-3">
        <button
          type="button"
          class="w-40 overflow-hidden rounded border text-left transition-colors"
          :class="!clipId ? 'border-indigo-400/70' : 'border-white/10 hover:border-white/30'"
          @click="clipId = ''"
        >
          <span class="flex aspect-square items-center justify-center bg-white/5 text-sm text-slate-500">Rest pose</span>
          <span class="block px-2 py-1.5 text-sm">Rest pose</span>
        </button>
        <button
          v-for="clip in filtered.slice(0, limit)"
          :key="clip.id"
          type="button"
          class="w-40 overflow-hidden rounded border text-left transition-colors"
          :class="clip.id === clipId ? 'border-indigo-400/70' : 'border-white/10 hover:border-white/30'"
          :title="clip.description || clip.name"
          @click="clipId = clip.id"
        >
          <img
            v-if="clip.thumb"
            :src="`/api/char3d-review/clips/${clip.id}/thumb`"
            alt=""
            class="aspect-square w-full bg-white object-cover"
            loading="lazy"
          />
          <span v-else class="flex aspect-square items-center justify-center bg-white/5 text-xs text-slate-500">
            {{ clip.durS?.toFixed(1) }}s
          </span>
          <span class="block px-2 py-1.5">
            <span class="block truncate text-sm">{{ clip.name }}</span>
            <span class="block truncate text-xs text-slate-500">{{ clip.durS?.toFixed(1) }}s · {{ clip.tags.slice(0, 3).join(', ') }}</span>
          </span>
        </button>
      </div>
      <div v-if="filtered.length > limit" class="flex justify-center pt-2">
        <UiButton size="sm" @click="limit += LIMIT_STEP">Show more ({{ filtered.length - limit }})</UiButton>
      </div>
    </main>

    <!-- the viewer -->
    <aside class="w-[480px] shrink-0 space-y-2 overflow-y-auto border-l border-white/10 p-3">
      <p class="truncate text-sm font-medium">{{ current?.name ?? 'No character' }}</p>
      <!-- The viewer grows with `flex-1` inside, so its height is set on this wrapper. -->
      <div class="flex flex-col" style="height: min(68vh, 680px)">
        <ClientOnly>
          <AnimViewer :model-url="modelUrl" :clip-url="clipUrl" class="min-h-0 flex-1" />
        </ClientOnly>
      </div>
      <div class="space-y-1 border-t border-white/10 pt-2">
        <p class="text-sm font-medium">{{ currentClip?.name ?? 'Rest pose' }}</p>
        <p v-if="currentClip?.description" class="text-sm text-slate-400">{{ currentClip.description }}</p>
        <div v-if="currentClip" class="flex flex-wrap gap-1">
          <span v-for="tag in currentClip.tags" :key="tag" class="rounded-full border border-white/15 px-2 py-0.5 text-xs">{{ tag }}</span>
        </div>
        <p v-if="currentClip" class="text-xs text-slate-500">
          {{ currentClip.durS?.toFixed(2) }}s · {{ currentClip.frames }} frames<template v-if="currentClip.source"> · {{ currentClip.source }}</template>
        </p>
        <p class="text-xs text-slate-500">
          A screenshot misleads here: a wave can look like a hand over the cheek from the front and sit in front
          of the chest from the side. Turn the camera before calling a collision.
        </p>
      </div>
    </aside>
  </div>
</template>
