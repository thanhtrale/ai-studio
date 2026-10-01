import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from 'firebase/auth';
import type { CloudJobOwner } from '@ai-studio/cloud-contract';

export function useAuth() {
  const nuxt = useNuxtApp();
  const user = (nuxt.$authUser ?? shallowRef(null)) as Ref<User | null>;
  const ready = (nuxt.$authReady ?? ref(true)) as Ref<boolean>;
  const error = ref<string | null>(null);
  const busy = ref(false);

  function auth(): Auth {
    const instance = nuxt.$firebaseAuth as Auth | undefined;
    if (!instance) throw new Error('Firebase chưa được cấu hình (thiếu NUXT_PUBLIC_FIREBASE_*)');
    return instance;
  }

  const owner = computed<CloudJobOwner | null>(() =>
    user.value
      ? { uid: user.value.uid, email: user.value.email, name: user.value.displayName }
      : null,
  );

  async function signIn() {
    busy.value = true;
    error.value = null;
    try {
      await signInWithPopup(auth(), new GoogleAuthProvider());
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy.value = false;
    }
  }

  async function signOut() {
    await firebaseSignOut(auth());
  }

  return { user, ready, owner, error, busy, signIn, signOut };
}
