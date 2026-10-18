<script setup lang="ts">
/**
 * 3D characters: every character, and a new one from a reference image.
 *
 * The chain behind each is reference -> three-view A-pose sheet -> Pixal3D
 * mesh -> Mixamo rig, one step per run, each looked at before the next. A
 * character's own page (`/char3d/<id>`) is where that happens. The store is
 * `storage/char3d/`; see `server/char3d/store.ts`.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import type { Char3dCharacterSummary } from '#shared/char3d';

import UiAlert from '../../components/ui/Alert.vue';
import UiBadge from '../../components/ui/Badge.vue';
import UiButton from '../../components/ui/Button.vue';
import UiCard from '../../components/ui/Card.vue';
import UiField from '../../components/ui/Field.vue';
import UiInput from '../../components/ui/Input.vue';
import UiTextarea from '../../components/ui/Textarea.vue';

useHead({ title: '3D characters' });

const { data, refresh } = await useFetch<{ characters: Char3dCharacterSummary[] }>('/api/char3d');
const characters = computed(() => data.value?.characters ?? []);

const creating = ref(false);
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
          <h1 class="text-2xl font-semibold">3D characters</h1>
          <p class="text-sm text-slate-400">
            Reference → three-view A-pose sheet → Pixal3D mesh → Mixamo rig and clips. One step per run, each
            reviewed before the next uses it.
          </p>
        </div>
        <NuxtLink
          to="/char3d/review"
          class="rounded px-3 py-1.5 text-sm text-slate-400 hover:bg-white/5 hover:text-slate-100"
          title="Saved rigged characters × the Mixamo clip library"
        >
          Animation review
        </NuxtLink>
        <UiButton v-if="!creating" variant="primary" @click="creating = true">New character</UiButton>
      </header>

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

      <p v-if="!characters.length && !creating" class="text-sm text-slate-500">No characters yet.</p>

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
