import {
  deleteObject,
  getDownloadURL,
  getMetadata,
  listAll,
  ref as storageRef,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage';
import {
  MAX_REFERENCE_BYTES,
  STORAGE_REF_PREFIX,
  type CloudJobReference,
} from '@ai-studio/cloud-contract';

/** Reads intrinsic dimensions without decoding the whole file into a canvas. */
function measure(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export function useReferenceLibrary() {
  const nuxt = useNuxtApp();
  const { user } = useAuth();

  const items = ref<CloudJobReference[]>([]);
  const pending = ref(false);
  const uploading = ref(false);
  const error = ref<string | null>(null);

  function storage(): FirebaseStorage {
    const instance = nuxt.$firebaseStorage as FirebaseStorage | undefined;
    if (!instance) throw new Error('Firebase chưa được cấu hình (thiếu NUXT_PUBLIC_FIREBASE_*)');
    return instance;
  }

  function folder(): string {
    const uid = user.value?.uid;
    if (!uid) throw new Error('Chưa đăng nhập');
    return `${STORAGE_REF_PREFIX}/${uid}`;
  }

  async function refresh() {
    pending.value = true;
    error.value = null;
    try {
      const listing = await listAll(storageRef(storage(), folder()));
      const entries = await Promise.all(
        listing.items.map(async (item) => {
          const [url, meta] = await Promise.all([getDownloadURL(item), getMetadata(item)]);
          return {
            name: meta.customMetadata?.['originalName'] ?? item.name,
            storagePath: item.fullPath,
            downloadUrl: url,
            contentType: meta.contentType ?? 'image/*',
            width: meta.customMetadata?.['width'] ? Number(meta.customMetadata['width']) : null,
            height: meta.customMetadata?.['height'] ? Number(meta.customMetadata['height']) : null,
            bytes: meta.size,
          } satisfies CloudJobReference;
        }),
      );
      items.value = entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pending.value = false;
    }
  }

  async function upload(file: File): Promise<CloudJobReference | null> {
    error.value = null;
    if (!file.type.startsWith('image/')) {
      error.value = 'Chỉ nhận tệp ảnh';
      return null;
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      error.value = `Ảnh quá lớn (tối đa ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)} MB)`;
      return null;
    }

    uploading.value = true;
    try {
      const size = await measure(file);
      const target = storageRef(storage(), `${folder()}/${Date.now()}-${file.name}`);
      const result = await uploadBytes(target, file, {
        contentType: file.type,
        customMetadata: {
          originalName: file.name,
          ...(size ? { width: String(size.width), height: String(size.height) } : {}),
        },
      });

      const entry: CloudJobReference = {
        name: file.name,
        storagePath: result.ref.fullPath,
        downloadUrl: await getDownloadURL(result.ref),
        contentType: file.type,
        width: size?.width ?? null,
        height: size?.height ?? null,
        bytes: file.size,
      };
      items.value = [entry, ...items.value];
      return entry;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      uploading.value = false;
    }
  }

  async function remove(path: string) {
    try {
      await deleteObject(storageRef(storage(), path));
      items.value = items.value.filter((item) => item.storagePath !== path);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  return { items, pending, uploading, error, refresh, upload, remove };
}
