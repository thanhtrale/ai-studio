import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import { GALLERY_PATH, type CloudGalleryDoc } from '@ai-studio/cloud-contract';

export function useCloudGallery() {
  const nuxt = useNuxtApp();

  const items = ref<CloudGalleryDoc[]>([]);
  const pending = ref(true);
  const error = ref<string | null>(null);

  let unsubscribe: Unsubscribe | null = null;

  function db(): Firestore {
    const instance = nuxt.$firestore as Firestore | undefined;
    if (!instance) throw new Error('Firebase chưa được cấu hình (thiếu NUXT_PUBLIC_FIREBASE_*)');
    return instance;
  }

  onMounted(() => {
    try {
      const galleryQuery = query(collection(db(), ...GALLERY_PATH), orderBy('createdAt', 'desc'), limit(60));
      unsubscribe = onSnapshot(
        galleryQuery,
        (snapshot) => {
          items.value = snapshot.docs.map((entry) => entry.data() as CloudGalleryDoc);
          pending.value = false;
        },
        (cause) => {
          error.value = cause.message;
          pending.value = false;
        },
      );
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      pending.value = false;
    }
  });

  onBeforeUnmount(() => unsubscribe?.());

  // Removes the gallery entry only. The video object stays in Storage until a
  // lifecycle rule collects it; a browser client has no business deleting what
  // the worker wrote.
  async function remove(id: string) {
    await deleteDoc(doc(db(), ...GALLERY_PATH, id));
  }

  return { items, pending, error, remove };
}
