import { groupMedia, type MediaItem, type MediaKind } from '#shared/library';

/** Every media byte the browser sees comes through this one route. */
export function mediaUrl(id: string): string {
  return `/api/media/file?id=${encodeURIComponent(id)}`;
}

/**
 * The library index.
 *
 * Shared under one `useAsyncData` key, so the picker on the generate page and
 * the library page are looking at the same list: uploading a reference image in
 * one shows up in the other without a reload.
 */
export function useMedia() {
  const { data, refresh, status } = useAsyncData<{ items: MediaItem[] }>(
    'media',
    () => $fetch('/api/media'),
    { default: () => ({ items: [] }) },
  );

  const items = computed(() => data.value?.items ?? []);
  const groups = computed(() => groupMedia(items.value));
  const byId = computed(() => new Map(items.value.map((item) => [item.id, item])));

  const pending = computed(() => status.value === 'pending');

  function ofKind(kind: MediaKind): MediaItem[] {
    return items.value.filter((item) => item.kind === kind);
  }

  /** Sends one file to the upload route and returns the entry it became. */
  async function upload(file: File): Promise<MediaItem> {
    const form = new FormData();
    form.append('file', file, file.name);

    const response = await $fetch<{ media: MediaItem }>('/api/media/upload', { method: 'POST', body: form });
    await refresh();
    return response.media;
  }

  return { items, groups, byId, pending, ofKind, upload, refresh };
}
