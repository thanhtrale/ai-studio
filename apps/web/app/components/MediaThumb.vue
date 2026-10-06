<script setup lang="ts">
/**
 * One media file as a picture.
 *
 * Video thumbnails are the `<video>` element itself with a `#t=` fragment rather
 * than a generated poster image: the browser decodes the frame, so the studio
 * needs no ffmpeg of its own and no second copy of anything on disk. It is also
 * why the media route answers range requests -- without them the fragment is
 * ignored and the frame comes out black.
 */
import { mediaKind, meshEngineLabel, type MediaItem, type MediaKind } from '#shared/library';

const KIND_LABELS: Record<MediaKind, string> = { image: 'Image', video: 'Video', model: '3D model' };
const KIND_GLYPHS: Record<MediaKind, string> = { image: '▣', video: '▶', model: '◆' };

withDefaults(
  defineProps<{
    item: MediaItem;
    fit?: 'cover' | 'contain';
    /**
     * Show what kind of file this is.
     *
     * Off by default: a picker that only offers images would put the same icon
     * on every tile, which says nothing. It earns its place in a list that
     * mixes the two.
     */
    kindBadge?: boolean;
  }>(),
  { fit: 'cover', kindBadge: false },
);
</script>

<template>
  <div class="relative h-full w-full overflow-hidden bg-black/40">
    <span
      v-if="kindBadge"
      :title="KIND_LABELS[item.kind]"
      :aria-label="KIND_LABELS[item.kind]"
      :data-testid="`kind-${item.kind}`"
      class="absolute left-1 top-1 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-none text-slate-200"
    >
      {{ KIND_GLYPHS[item.kind] }}
    </span>
    <img
      v-if="item.kind === 'image'"
      :src="mediaUrl(item.id)"
      :alt="item.name"
      loading="lazy"
      class="h-full w-full"
      :class="fit === 'cover' ? 'object-cover' : 'object-contain'"
    />
    <!-- A mesh is shown by the photograph it was made from: a grid of live
         WebGL views would be one context per card, and browsers stop at sixteen. -->
    <template v-else-if="item.kind === 'model'">
      <!-- A rig's reference is the mesh it rigged, which an <img> cannot show. -->
      <img
        v-if="item.meta?.referenceId && mediaKind(item.meta.referenceId) === 'image'"
        :src="mediaUrl(item.meta.referenceId)"
        :alt="item.name"
        loading="lazy"
        class="h-full w-full opacity-80"
        :class="fit === 'cover' ? 'object-cover' : 'object-contain'"
      />
      <span v-else class="flex h-full w-full items-center justify-center text-2xl text-indigo-300/60">◆</span>
      <span class="absolute bottom-1 right-1 flex gap-1">
        <span
          v-if="meshEngineLabel(item)"
          :title="item.meta?.armId"
          class="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-200"
        >
          {{ meshEngineLabel(item) }}
        </span>
        <span class="rounded bg-indigo-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white">3D</span>
      </span>
    </template>
    <template v-else>
      <video
        :src="`${mediaUrl(item.id)}#t=0.1`"
        preload="metadata"
        muted
        playsinline
        class="h-full w-full"
        :class="fit === 'cover' ? 'object-cover' : 'object-contain'"
      />
      <span
        class="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-200"
      >
        {{ item.meta?.output?.seconds === undefined ? 'video' : `${item.meta.output.seconds.toFixed(1)}s` }}
      </span>
    </template>
  </div>
</template>
