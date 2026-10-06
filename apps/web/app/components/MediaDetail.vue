<script setup lang="ts">
/**
 * The explorer-style pane: what this file is, and what made it.
 *
 * Pixel dimensions are read off the loaded element rather than the record,
 * because for an uploaded file there is no record to read them from -- and for a
 * generated one it is a check on the record rather than a repeat of it.
 */
import { computed, ref, watch } from 'vue';

import {
  formatBytes,
  formatCount,
  isImageSettings,
  isModelSettings,
  isRigSettings,
  isVideoSettings,
  type MediaItem,
} from '#shared/library';

import MediaThumb from './MediaThumb.vue';
import ModelViewer from './ModelViewer.vue';
import UiBadge from './ui/Badge.vue';
import UiButton from './ui/Button.vue';

const props = defineProps<{ item: MediaItem; reference?: MediaItem | null }>();
const emit = defineEmits<{ preview: [MediaItem]; openReference: [MediaItem] }>();

const measured = ref<{ width: number; height: number; seconds?: number } | null>(null);

watch(() => props.item.id, () => (measured.value = null));

function onImage(event: Event): void {
  const image = event.target as HTMLImageElement;
  measured.value = { width: image.naturalWidth, height: image.naturalHeight };
}

function onVideo(event: Event): void {
  const video = event.target as HTMLVideoElement;
  measured.value = { width: video.videoWidth, height: video.videoHeight, seconds: video.duration };
}

const meta = computed(() => props.item.meta);
const settings = computed(() => meta.value?.settings);

/**
 * The two shapes a record's settings can have.
 *
 * Narrowed here rather than in the template so the markup reads as two
 * alternatives rather than a field-by-field guard, and so a record written
 * before there was a second modality still resolves as the video one.
 */
const video = computed(() => (isVideoSettings(settings.value) ? settings.value : null));
const image = computed(() => (isImageSettings(settings.value) ? settings.value : null));
const model = computed(() => (isModelSettings(settings.value) ? settings.value : null));
const rig = computed(() => (isRigSettings(settings.value) ? settings.value : null));
/** The settings that describe a frame -- every kind but a mesh. */
const framed = computed(() => video.value ?? image.value);

/** Where "use these settings" goes: the console that can actually take them. */
const consolePath = computed(() =>
  rig.value
    ? '/generate/rig'
    : model.value
      ? '/generate/model'
      : image.value
        ? '/generate/image'
        : '/generate/video',
);

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The knobs that were on, named the way the console names them. */
const features = computed(() => {
  const on: string[] = [];
  if (video.value?.enhancePrompt) on.push('prompt enhancer');
  if (video.value?.spatialUpsample) on.push('spatial ×2');
  if (video.value?.temporalUpsample) on.push('temporal ×2');
  if (image.value && image.value.batch > 1) on.push(`batch ${image.value.batchIndex + 1}/${image.value.batch}`);
  if (model.value && model.value.batch > 1) on.push(`batch ${model.value.batchIndex + 1}/${model.value.batch}`);
  if (model.value?.removeBackground) on.push('background removed');
  if (meta.value?.output?.textured) on.push('textured');
  if (rig.value?.removeFingers) on.push('fingers folded');
  if (rig.value?.inPlace) on.push('in place');
  if (model.value?.compressTextures) {
    const quality = model.value.textureQuality ?? 100;
    on.push(quality >= 100 ? 'WebP lossless' : `WebP ${quality}%`);
  }
  const references = meta.value?.referenceIds?.length ?? (meta.value?.referenceId ? 1 : 0);
  if (references > 0 && props.item.kind !== 'model') {
    on.push(props.item.kind === 'video' ? 'image-to-video' : `${references} reference`);
  }
  return on;
});
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Orbitable in place: a click on a mesh is a drag more often than a request
         to open it, so the preview is the button below rather than the panel. -->
    <div
      v-if="item.kind === 'model'"
      class="aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-white/10"
    >
      <ModelViewer :key="item.id" :src="mediaUrl(item.id)" compact />
    </div>
    <div
      v-else
      class="group relative aspect-video w-full shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-white/10"
      @click="emit('preview', item)"
    >
      <img
        v-if="item.kind === 'image'"
        :src="mediaUrl(item.id)"
        :alt="item.name"
        class="h-full w-full object-contain"
        @load="onImage"
      />
      <video
        v-else
        :key="item.id"
        :src="`${mediaUrl(item.id)}#t=0.1`"
        preload="metadata"
        muted
        class="h-full w-full object-contain"
        @loadedmetadata="onVideo"
      />
      <span
        class="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-center text-xs text-slate-300 opacity-0 transition-opacity group-hover:opacity-100"
      >
        Click to preview
      </span>
    </div>

    <div class="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <div>
        <h2 class="break-all text-sm font-semibold text-slate-100">{{ item.name }}</h2>
        <p class="mt-1 break-all text-xs text-slate-500">{{ item.id }}</p>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <UiBadge :tone="meta?.source === 'generated' ? 'accent' : 'neutral'">
          {{ meta?.source ?? 'untracked' }}
        </UiBadge>
        <UiBadge>{{ item.kind }}</UiBadge>
        <UiBadge v-for="feature in features" :key="feature" tone="ok">{{ feature }}</UiBadge>
      </div>

      <dl class="space-y-1.5 text-xs">
        <div class="flex justify-between gap-3">
          <dt class="text-slate-500">Size</dt>
          <dd class="text-slate-300">{{ formatBytes(item.bytes) }}</dd>
        </div>
        <div v-if="measured" class="flex justify-between gap-3">
          <dt class="text-slate-500">Dimensions</dt>
          <dd class="text-slate-300">
            {{ measured.width }}&#215;{{ measured.height }}
            <span v-if="measured.seconds">&middot; {{ measured.seconds.toFixed(2) }}s</span>
          </dd>
        </div>
        <div v-if="item.meta?.output?.faces" class="flex justify-between gap-3">
          <dt class="text-slate-500">Geometry</dt>
          <dd class="text-slate-300">
            {{ formatCount(item.meta.output.faces) }} faces
            <span v-if="item.meta.output.vertices">
              &middot; {{ formatCount(item.meta.output.vertices) }} verts
            </span>
          </dd>
        </div>
        <div
          v-if="item.meta?.output?.numFrames && item.meta.output.fps"
          class="flex justify-between gap-3"
        >
          <dt class="text-slate-500">Frames</dt>
          <dd class="text-slate-300">
            {{ item.meta.output.numFrames }} &middot; {{ Math.round(item.meta.output.fps) }} fps
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-slate-500">Created</dt>
          <dd class="text-slate-300">{{ when(meta?.createdAt ?? item.modifiedAt) }}</dd>
        </div>
        <div v-if="meta?.armId" class="flex justify-between gap-3">
          <dt class="text-slate-500">Arm</dt>
          <dd class="break-all text-right text-slate-300">{{ meta.armId }}</dd>
        </div>
        <div v-if="meta?.jobId" class="flex justify-between gap-3">
          <dt class="text-slate-500">Job</dt>
          <dd class="break-all text-right font-mono text-[10px] text-slate-400">{{ meta.jobId }}</dd>
        </div>
        <div v-if="meta?.originalName" class="flex justify-between gap-3">
          <dt class="text-slate-500">Uploaded as</dt>
          <dd class="break-all text-right text-slate-300">{{ meta.originalName }}</dd>
        </div>
      </dl>

      <section v-if="meta?.prompt" class="space-y-1">
        <h3 class="text-xs font-medium uppercase tracking-wide text-slate-500">Prompt</h3>
        <p class="whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-slate-300">{{ meta.prompt }}</p>
      </section>

      <section v-if="meta?.promptUsed" class="space-y-1">
        <h3 class="text-xs font-medium uppercase tracking-wide text-slate-500">
          Enhanced, as sent to the model
        </h3>
        <p class="whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-slate-400">{{ meta.promptUsed }}</p>
      </section>

      <section v-if="reference" class="space-y-1">
        <h3 class="text-xs font-medium uppercase tracking-wide text-slate-500">Reference</h3>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded border border-white/10 p-2 text-left hover:border-white/30"
          @click="emit('openReference', reference)"
        >
          <span class="h-10 w-10 shrink-0 overflow-hidden rounded">
            <MediaThumb :item="reference" />
          </span>
          <span class="min-w-0 flex-1 truncate text-xs text-slate-300">{{ reference.name }}</span>
        </button>
      </section>

      <section v-if="settings" class="space-y-1">
        <h3 class="text-xs font-medium uppercase tracking-wide text-slate-500">Settings</h3>
        <dl class="space-y-1 text-xs">
          <div v-if="rig" class="flex justify-between gap-3">
            <dt class="text-slate-500">Rig</dt>
            <dd class="text-right text-slate-300">
              {{ meta?.output?.bones ?? '?' }} bones · Mixamo skeleton<br />
              {{ rig.clips.length ? rig.clips.join(', ') : 'no clips' }}
            </dd>
          </div>
          <div v-else-if="model?.engine === 'trellis2'" class="flex justify-between gap-3">
            <dt class="text-slate-500">TRELLIS.2</dt>
            <dd class="text-right text-slate-300">
              {{ model.structureSteps }}/{{ model.shapeSteps }}/{{ model.refineSteps }}/{{ model.textureSteps }}
              step &middot; cfg {{ model.cfgScale }}<br />
              shape {{ model.shapeResolution }} &middot; {{ model.textureSize }}px maps<br />
              ≤{{ formatCount(model.targetFaces) }} faces
              <span v-if="model.bakeNormals">&middot; normals</span>
              <span v-if="model.bakeOcclusion">&middot; AO</span>
            </dd>
          </div>
          <div v-else-if="model?.engine === 'hunyuan3d-paint'" class="flex justify-between gap-3">
            <dt class="text-slate-500">Hunyuan3D Paint</dt>
            <dd class="text-right text-slate-300">
              {{ model.steps }} step &middot; cfg {{ model.cfgScale }} &middot; octree {{ model.octreeResolution }}<br />
              ≤{{ formatCount(model.targetFaces) }} faces
              <template v-if="model.texture !== false">
                <br />{{ model.paintViews }} views at {{ model.paintResolution }} &middot; {{ model.textureSize }}px
                <span v-if="model.upscale">&middot; ESRGAN</span>
              </template>
              <template v-else><br />shape only</template>
            </dd>
          </div>
          <div v-else-if="model" class="flex justify-between gap-3">
            <dt class="text-slate-500">Shape</dt>
            <dd class="text-right text-slate-300">
              {{ model.steps }} step &middot; cfg {{ model.cfgScale }}<br />
              octree {{ model.octreeResolution }} &middot; {{ model.latentTokens }} tokens<br />
              {{ model.targetFaces ? `decimated to ≤${formatCount(model.targetFaces)}` : 'raw surface' }}
            </dd>
          </div>
          <div v-if="framed" class="flex justify-between gap-3">
            <dt class="text-slate-500">Requested</dt>
            <dd class="text-slate-300">
              {{ framed.width }}&#215;{{ framed.height }}
              <span v-if="video">&middot; {{ video.numFrames }}f &middot; {{ video.frameRate }} fps</span>
            </dd>
          </div>
          <div v-if="image" class="flex justify-between gap-3">
            <dt class="text-slate-500">Sampling</dt>
            <dd class="text-right text-slate-300">
              {{ image.steps }} step &middot; cfg {{ image.cfgScale }}<br />
              {{ image.sampler }} &middot; {{ image.scheduler }} &middot; shift {{ image.flowShift }}
            </dd>
          </div>
          <div v-if="framed?.aspect" class="flex justify-between gap-3">
            <dt class="text-slate-500">Aspect</dt>
            <dd class="text-slate-300">
              {{ framed.aspect }}
              <span v-if="framed.megapixels">&middot; {{ framed.megapixels.toFixed(2) }} MP</span>
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-slate-500">Seed</dt>
            <dd class="font-mono text-slate-300">{{ settings.seed }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="meta?.report" class="space-y-1">
        <h3 class="text-xs font-medium uppercase tracking-wide text-slate-500">Run</h3>
        <dl class="space-y-1 text-xs">
          <div class="flex justify-between gap-3">
            <dt class="text-slate-500">Total</dt>
            <dd class="text-slate-300">{{ meta.report.secondsTotal.toFixed(1) }}s</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-slate-500">Peak VRAM</dt>
            <dd class="text-right text-slate-300">
              {{ meta.report.peakVramGib.toFixed(2) }} GiB
              <span v-if="meta.report.peakVramScope === 'card'" class="text-slate-500">
                <br />whole card
              </span>
            </dd>
          </div>
          <div v-for="stage in meta.report.stages" :key="stage.name" class="flex justify-between gap-3">
            <dt class="text-slate-500">{{ stage.name }}</dt>
            <dd class="text-slate-400">{{ stage.seconds.toFixed(1) }}s</dd>
          </div>
        </dl>
      </section>
    </div>

    <div class="mt-4 flex shrink-0 flex-wrap gap-2 border-t border-white/10 pt-4">
      <UiButton size="sm" variant="primary" @click="emit('preview', item)">Preview</UiButton>
      <NuxtLink v-if="settings" :to="{ path: consolePath, query: { from: item.id } }">
        <UiButton size="sm">Use these settings</UiButton>
      </NuxtLink>
      <template v-if="item.kind === 'image'">
        <NuxtLink :to="{ path: '/generate/image', query: { reference: item.id } }">
          <UiButton size="sm">Edit this image</UiButton>
        </NuxtLink>
        <NuxtLink :to="{ path: '/generate/video', query: { reference: item.id } }">
          <UiButton size="sm">Animate this image</UiButton>
        </NuxtLink>
        <NuxtLink :to="{ path: '/generate/model', query: { reference: item.id } }">
          <UiButton size="sm">Make a 3D model</UiButton>
        </NuxtLink>
      </template>
      <NuxtLink v-if="item.kind === 'model' && !rig" :to="{ path: '/generate/rig', query: { mesh: item.id } }">
        <UiButton size="sm">Rig &amp; animate</UiButton>
      </NuxtLink>
      <a v-if="item.kind === 'model'" :href="mediaUrl(item.id)" :download="item.name">
        <UiButton size="sm">Download GLB</UiButton>
      </a>
    </div>
  </div>
</template>
