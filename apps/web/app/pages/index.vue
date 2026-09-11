<script setup lang="ts">
/**
 * The landing page: what the studio can do, one card each.
 *
 * Readiness is read off the arm inventory rather than hard-coded, so a card says
 * "no arm discovered" when the manifest is missing and "no console yet" when the
 * arm exists but nothing has been built to drive it. Those are different
 * problems and the card should not blur them.
 */
import { computed } from 'vue';

import type { ArmCapability, ArmModality } from '@ai-studio/arm-contract';

import MediaThumb from '../components/MediaThumb.vue';
import UiBadge from '../components/ui/Badge.vue';
import UiCard from '../components/ui/Card.vue';

useHead({ title: 'Home' });

const { arms } = useArms();
const { items } = useMedia();

interface StudioFunction {
  key: string;
  title: string;
  blurb: string;
  modality: ArmModality;
  /** The job contract this card's console needs; null when it has no console. */
  capability: ArmCapability | null;
  /** Null while no console has been built for this modality. */
  to: string | null;
  glyph: string;
}

const FUNCTIONS: StudioFunction[] = [
  {
    key: 'video',
    title: 'Video generation',
    blurb:
      'LTX-2.5 distilled, eight steps, video and audio in one pass. Text-to-video or a still to animate, with the first-party prompt enhancer and both latent upsamplers.',
    modality: 'video',
    capability: 'video.generate',
    to: '/generate/video',
    glyph: '▶',
  },
  {
    key: 'image',
    title: 'Image generation',
    blurb:
      'Qwen-Image-Edit on stable-diffusion.cpp. Text-to-image, or up to four reference images composed into one edit, with a batch that writes every attempt to the library separately.',
    modality: 'image',
    capability: 'image.generate',
    to: '/generate/image',
    glyph: '▣',
  },
  {
    key: 'text',
    title: 'Text',
    blurb: 'A llama.cpp arm is scaffolded. No console yet.',
    modality: 'text',
    capability: null,
    to: null,
    glyph: '≡',
  },
];

function status(entry: StudioFunction): { tone: 'ok' | 'warn' | 'neutral'; label: string } {
  // A card is about a console, so it counts arms that can serve one -- except
  // the text card, which has no console and no capability to count.
  const candidates = arms.value.filter((arm) =>
    entry.capability ? arm.capabilities.includes(entry.capability) : arm.modality === entry.modality,
  );
  if (candidates.length === 0) return { tone: 'warn', label: 'no arm discovered' };
  if (!entry.to) return { tone: 'neutral', label: 'no console yet' };
  if (candidates.some((arm) => arm.state === 'running')) return { tone: 'ok', label: 'arm running' };
  return { tone: 'neutral', label: 'arm ready' };
}

/** The four newest, to make the library card say something rather than sit there. */
const recent = computed(() =>
  [...items.value]
    .sort(
      (a, b) => Date.parse(b.meta?.createdAt ?? b.modifiedAt) - Date.parse(a.meta?.createdAt ?? a.modifiedAt),
    )
    .slice(0, 4),
);
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-5xl space-y-8 p-8">
      <header class="space-y-1">
        <h1 class="text-2xl font-semibold">AI Studio</h1>
        <p class="text-sm text-slate-400">
          Generation runs on this machine, one arm on the GPU at a time. Everything produced or uploaded
          lands in the library.
        </p>
      </header>

      <section class="grid gap-4 sm:grid-cols-2">
        <component
          :is="entry.to ? 'NuxtLink' : 'div'"
          v-for="entry in FUNCTIONS"
          :key="entry.key"
          :to="entry.to ?? undefined"
          class="block"
        >
          <UiCard :interactive="entry.to !== null" class="h-full">
            <div class="space-y-3 p-5">
              <div class="flex items-start justify-between gap-3">
                <span class="text-xl text-indigo-400">{{ entry.glyph }}</span>
                <UiBadge :tone="status(entry).tone">{{ status(entry).label }}</UiBadge>
              </div>
              <h2 class="text-base font-semibold" :class="entry.to ? 'text-slate-100' : 'text-slate-400'">
                {{ entry.title }}
              </h2>
              <p class="text-sm text-slate-400">{{ entry.blurb }}</p>
            </div>
          </UiCard>
        </component>

        <NuxtLink to="/library" class="block">
          <UiCard interactive class="h-full">
            <div class="space-y-3 p-5">
              <div class="flex items-start justify-between gap-3">
                <span class="text-xl text-indigo-400">&#9707;</span>
                <UiBadge tone="accent">{{ items.length }} file{{ items.length === 1 ? '' : 's' }}</UiBadge>
              </div>
              <h2 class="text-base font-semibold text-slate-100">Library</h2>
              <p class="text-sm text-slate-400">
                Everything generated or uploaded, filed by day and by test run, with the prompt and settings
                each one came from.
              </p>
              <ul v-if="recent.length" class="flex gap-2 pt-1">
                <li
                  v-for="entry in recent"
                  :key="entry.id"
                  class="h-14 w-14 overflow-hidden rounded border border-white/10"
                >
                  <MediaThumb :item="entry" kind-badge />
                </li>
              </ul>
            </div>
          </UiCard>
        </NuxtLink>
      </section>
    </div>
  </div>
</template>
