<script setup lang="ts">
/**
 * Choosing a media input: pick one the studio already has, or add one now.
 *
 * Both halves are here on purpose. A reference image is usually reused -- the
 * same still conditioning several attempts -- so the list comes first and the
 * file dialog is the fallback, not the default.
 */
import { computed, ref } from 'vue';

import { formatBytes, groupLabel, type MediaItem, type MediaKind } from '#shared/library';

import MediaThumb from './MediaThumb.vue';
import UiAlert from './ui/Alert.vue';
import UiButton from './ui/Button.vue';
import UiModal from './ui/Modal.vue';

const props = withDefaults(defineProps<{ open: boolean; kind?: MediaKind; selectedId?: string | null }>(), {
  kind: 'image',
  selectedId: null,
});

const emit = defineEmits<{ close: []; select: [string | null] }>();

const { groups, upload, refresh, pending } = useMedia();

const input = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const failure = ref<string | null>(null);

const ACCEPT = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/webm',
} as const;

/** Folders that hold anything of the wanted kind, in the library's own order. */
const visible = computed(() =>
  groups.value
    .map((group) => ({ ...group, items: group.items.filter((item) => item.kind === props.kind) }))
    .filter((group) => group.items.length > 0),
);

const total = computed(() => visible.value.reduce((sum, group) => sum + group.items.length, 0));

async function onFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  uploading.value = true;
  failure.value = null;
  try {
    const media = await upload(file);
    // Choosing it straight away is the whole reason the dialog was opened.
    emit('select', media.id);
    emit('close');
  } catch (error) {
    failure.value = describeFetchError(error);
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = '';
  }
}

function choose(item: MediaItem): void {
  emit('select', item.id);
  emit('close');
}
</script>

<template>
  <UiModal
    :open="open"
    size="lg"
    title="Media"
    :subtitle="`${total} ${kind}${total === 1 ? '' : 's'} in the library`"
    @close="emit('close')"
  >
    <div class="space-y-5">
      <div class="flex flex-wrap items-center gap-2">
        <input
          ref="input"
          type="file"
          class="hidden"
          :accept="ACCEPT[kind]"
          data-testid="picker-file"
          @change="onFile"
        />
        <UiButton variant="primary" :disabled="uploading" @click="input?.click()">
          {{ uploading ? 'Uploading…' : 'Upload from this machine' }}
        </UiButton>
        <UiButton variant="ghost" size="sm" :disabled="pending" @click="refresh()">Refresh</UiButton>
        <UiButton v-if="selectedId" variant="ghost" size="sm" @click="emit('select', null); emit('close')">
          Clear selection
        </UiButton>
      </div>

      <UiAlert v-if="failure" tone="error">{{ failure }}</UiAlert>

      <p v-if="total === 0" class="text-sm text-slate-400">
        Nothing here yet. Uploads are written to the arm input directory, which is the only place an arm
        may read a reference from.
      </p>

      <section v-for="group in visible" :key="group.group" class="space-y-2">
        <h3 class="text-xs font-medium uppercase tracking-wide text-slate-500">
          {{ groupLabel(group.group) }}
        </h3>
        <ul class="grid grid-cols-3 gap-3 sm:grid-cols-4">
          <li v-for="item in group.items" :key="item.id">
            <button
              type="button"
              class="w-full overflow-hidden rounded-lg border text-left transition-colors"
              :class="
                item.id === selectedId
                  ? 'border-indigo-400'
                  : 'border-white/10 hover:border-white/30'
              "
              :data-testid="`pick-${item.id}`"
              @click="choose(item)"
            >
              <div class="aspect-square"><MediaThumb :item="item" /></div>
              <div class="space-y-0.5 p-2">
                <p class="truncate text-xs text-slate-200">{{ item.name }}</p>
                <p class="text-[10px] text-slate-500">{{ formatBytes(item.bytes) }}</p>
              </div>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </UiModal>
</template>
