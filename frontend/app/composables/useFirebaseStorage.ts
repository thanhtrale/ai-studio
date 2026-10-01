import {
  deleteObject,
  getDownloadURL,
  getMetadata,
  listAll,
  ref as storageRef,
  uploadBytesResumable,
  type FirebaseStorage,
} from 'firebase/storage';

export interface StorageFile {
  path: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
  updatedAt: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useFirebaseStorage(prefix?: string) {
  const config = useRuntimeConfig().public;
  const folder = prefix ?? config.storagePrefix;

  const files = ref<StorageFile[]>([]);
  const pending = ref(false);
  const uploading = ref(false);
  const progress = ref(0);
  const error = ref<string | null>(null);

  function storage(): FirebaseStorage {
    const instance = useNuxtApp().$firebaseStorage as FirebaseStorage | undefined;
    if (!instance) throw new Error('Firebase chưa được cấu hình (thiếu NUXT_PUBLIC_FIREBASE_*)');
    return instance;
  }

  async function refresh() {
    pending.value = true;
    error.value = null;
    try {
      const listing = await listAll(storageRef(storage(), folder));
      const entries = await Promise.all(
        listing.items.map(async (item) => {
          const [url, meta] = await Promise.all([getDownloadURL(item), getMetadata(item)]);
          return {
            path: item.fullPath,
            name: item.name,
            url,
            size: meta.size,
            contentType: meta.contentType ?? 'application/octet-stream',
            updatedAt: meta.updated,
          } satisfies StorageFile;
        }),
      );
      entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      files.value = entries;
    } catch (cause) {
      error.value = message(cause);
    } finally {
      pending.value = false;
    }
  }

  function upload(file: File) {
    error.value = null;
    uploading.value = true;
    progress.value = 0;

    // Resumable rather than a single PUT: these are media files, and a progress
    // number is the only honest thing to show while one is in flight.
    const task = uploadBytesResumable(
      storageRef(storage(), `${folder}/${Date.now()}-${file.name}`),
      file,
      { contentType: file.type || 'application/octet-stream' },
    );

    return new Promise<void>((resolve) => {
      task.on(
        'state_changed',
        (snapshot) => {
          progress.value = snapshot.totalBytes
            ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
            : 0;
        },
        (cause) => {
          error.value = message(cause);
          uploading.value = false;
          resolve();
        },
        async () => {
          uploading.value = false;
          await refresh();
          resolve();
        },
      );
    });
  }

  async function remove(path: string) {
    error.value = null;
    try {
      await deleteObject(storageRef(storage(), path));
      files.value = files.value.filter((entry) => entry.path !== path);
    } catch (cause) {
      error.value = message(cause);
    }
  }

  return { files, pending, uploading, progress, error, refresh, upload, remove };
}
