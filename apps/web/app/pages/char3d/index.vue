<script setup lang="ts">
/**
 * 3D: a new character from a reference image, the 3D gallery, then every
 * character.
 *
 * The chain behind each is reference -> three-view A-pose sheet -> Pixal3D
 * mesh -> Mixamo rig, one step per run, each looked at before the next. A
 * character's own page (`/char3d/<id>`) is where that happens; a good rig is
 * added from there to the gallery (`/char3d/gallery`), where it plays the
 * Mixamo clip library. The store is `storage/char3d/`; see
 * `server/char3d/store.ts`.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import type { Char3dCharacterSummary, Char3dClipLibrary, Char3dReviewEntry } from '#shared/char3d';

import UiAlert from '../../components/ui/Alert.vue';
import UiBadge from '../../components/ui/Badge.vue';
import UiButton from '../../components/ui/Button.vue';
import UiCard from '../../components/ui/Card.vue';
import UiField from '../../components/ui/Field.vue';
import UiInput from '../../components/ui/Input.vue';
import UiTextarea from '../../components/ui/Textarea.vue';

useHead({ title: '3D' });

const { data, refresh } = await useFetch<{ characters: Char3dCharacterSummary[] }>('/api/char3d');
const characters = computed(() => data.value?.characters ?? []);

const { data: galleryData } = await useFetch<{ saved: Char3dReviewEntry[] }>('/api/char3d-review');
const { data: library } = await useFetch<Char3dClipLibrary>('/api/char3d-review/clips');
const galleryEntries = computed(() => (galleryData.value?.saved ?? []).filter((entry) => !entry.missing));
const clipCount = computed(() => library.value?.clips.length ?? 0);
const galleryThumb = (entry: Char3dReviewEntry): string =>
  entry.thumb ? `/api/char3d/${entry.character}/file/${entry.thumb}` : '';

const creating = ref(true);
const form = reactive({ name: '', subject: 'chibi character', style: 'chibi', traits: '' });
const file = ref<File | null>(null);
const preview = ref('');
const failure = ref<string | null>(null);
const saving = ref(false);

function pick(event: Event): void {
  const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;
  if (preview.value) URL.revokeObjectURL(preview.value);
  file.value = chosen;
  preview.value = chosen ? URL.createObjectURL(chosen) : '';
}

async function create(): Promise<void> {
  if (!file.value) return;
  failure.value = null;
  saving.value = true;
  try {
    const body = new FormData();
    body.append('image', file.value);
    for (const [key, value] of Object.entries(form)) body.append(key, value);
    const character = await $fetch<{ id: string }>('/api/char3d', { method: 'POST', body });
    await navigateTo(`/char3d/${character.id}`);
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    saving.value = false;
  }
}

const refSrc = (character: Char3dCharacterSummary): string => `/api/char3d/${character.id}/file/${character.ref}`;
const STEP_LABEL = { ref: 'Ref', mesh: 'Mesh', rig: 'Rig' } as const;

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => (timer = setInterval(() => void refresh(), 8000)));
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (preview.value) URL.revokeObjectURL(preview.value);
});
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-5xl space-y-6 p-8">
      <header class="flex flex-wrap items-center gap-3">
        <div class="min-w-0 flex-1 space-y-1">
          <h1 class="text-2xl font-semibold">3D</h1>
          <p class="text-sm text-slate-400">
            Reference → three-view A-pose sheet → Pixal3D mesh → Mixamo rig and clips. One step per run, each
            reviewed before the next uses it.
          </p>
        </div>
        <UiButton v-if="!creating" variant="primary" @click="creating = true">New character</UiButton>
      </header>

      <!-- 1. generate a character -->
      <h2 v-if="creating" class="text-lg font-semibold">New character</h2>
      <UiCard v-if="creating">
        <form class="space-y-4 p-5" @submit.prevent="create">
          <div class="flex flex-wrap gap-4">
            <div class="min-w-48 flex-1">
              <UiField label="Name" for="c3-name" required>
                <UiInput id="c3-name" v-model="form.name" />
              </UiField>
            </div>
            <div class="min-w-48 flex-1">
              <UiField label="Subject" for="c3-subject" hint="English: it goes into every prompt.">
                <UiInput id="c3-subject" v-model="form.subject" placeholder="chibi boy" />
              </UiField>
            </div>
            <div class="w-40">
              <UiField label="Style" for="c3-style">
                <UiInput id="c3-style" v-model="form.style" />
              </UiField>
            </div>
          </div>
          <UiField
            label="Traits to keep"
            for="c3-traits"
            hint="English. The whole outfit, the colours, and every detail worn on one side — the model draws the hidden views from these words, not from the picture."
          >
            <UiTextarea
              id="c3-traits"
              v-model="form.traits"
              :rows="3"
              placeholder="black hair in a high ponytail, white wrap shirt with blue trim tied in one knot at the left hip, dark baggy pants"
            />
          </UiField>
          <div class="flex flex-wrap items-center gap-4">
            <UiField label="Reference image" for="c3-image" required>
              <input
                id="c3-image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                class="text-sm text-slate-300"
                @change="pick"
              />
            </UiField>
            <img v-if="preview" :src="preview" alt="" class="h-28 rounded border border-white/10 bg-white object-contain" />
          </div>
          <UiAlert v-if="failure" tone="error">{{ failure }}</UiAlert>
          <div class="flex gap-2">
            <UiButton type="submit" variant="primary" :disabled="saving || !form.name.trim() || !file">Create</UiButton>
            <UiButton variant="ghost" @click="creating = false">Cancel</UiButton>
          </div>
        </form>
      </UiCard>

      <!-- 2. the 3D gallery: good rigs x the clip library -->
      <section class="space-y-2">
        <div class="flex items-baseline gap-2">
          <h2 class="text-lg font-semibold">3D Gallery</h2>
          <span class="text-sm text-slate-500">
            {{ galleryEntries.length }} rigged character{{ galleryEntries.length === 1 ? '' : 's' }} · {{ clipCount }} animations
          </span>
          <span class="flex-1" />
          <NuxtLink to="/char3d/gallery" class="text-sm text-indigo-300 hover:text-indigo-200">Open gallery →</NuxtLink>
        </div>
        <NuxtLink to="/char3d/gallery" class="block">
          <UiCard interactive>
            <div class="flex gap-3 overflow-x-auto p-3">
              <p v-if="!galleryEntries.length" class="text-sm text-slate-500">
                Nothing in the gallery yet. Open a good rig run of a character and press "Add to 3D gallery".
              </p>
              <div v-for="entry in galleryEntries" :key="entry.id" class="w-32 shrink-0 space-y-1">
                <img
                  v-if="galleryThumb(entry)"
                  :src="galleryThumb(entry)"
                  alt=""
                  class="h-40 w-32 rounded bg-white object-contain"
                  loading="lazy"
                />
                <p class="truncate text-xs text-slate-300">{{ entry.name }}</p>
              </div>
            </div>
          </UiCard>
        </NuxtLink>
      </section>

      <!-- 3. every character -->
      <h2 class="text-lg font-semibold">Characters</h2>
      <p v-if="!characters.length" class="text-sm text-slate-500">No characters yet.</p>

      <section class="flex flex-wrap gap-4">
        <NuxtLink v-for="character in characters" :key="character.id" :to="`/char3d/${character.id}`" class="block w-72">
          <UiCard interactive class="h-full">
            <div class="flex gap-3 p-3">
              <img :src="refSrc(character)" alt="" class="h-24 w-20 shrink-0 rounded bg-white object-contain" loading="lazy" />
              <div class="min-w-0 space-y-1">
                <p class="truncate font-medium text-slate-100">{{ character.name }}</p>
                <p class="truncate text-xs text-slate-400">{{ character.subject }} · {{ character.style }}</p>
                <p class="text-xs text-slate-300">{{ character.runs }} run{{ character.runs === 1 ? '' : 's' }}</p>
                <p v-if="character.lastRun" class="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                  <span>last: {{ STEP_LABEL[character.lastRun.step] }} {{ character.lastRun.id }}</span>
                  <UiBadge
                    :tone="
                      character.lastRun.status === 'done'
                        ? 'ok'
                        : character.lastRun.status === 'error'
                          ? 'bad'
                          : 'accent'
                    "
                  >
                    {{ character.lastRun.status }}
                  </UiBadge>
                  <span v-if="character.lastRun.review">{{ character.lastRun.review.score }}/100</span>
                </p>
              </div>
            </div>
          </UiCard>
        </NuxtLink>
      </section>
    </div>
  </div>
</template>
