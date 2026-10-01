import { getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Client-only: the Firebase Web SDK talks to Storage from the browser, and the
// prerender pass has no credentials and no window to attach them to.
export default defineNuxtPlugin(() => {
  const { firebase } = useRuntimeConfig().public;

  if (!firebase.apiKey || !firebase.storageBucket) {
    console.warn('[firebase] missing NUXT_PUBLIC_FIREBASE_* env vars; storage is disabled');
    return;
  }

  const app = getApps().length ? getApp() : initializeApp(firebase as FirebaseOptions);
  const auth = getAuth(app);

  const authUser = shallowRef<User | null>(auth.currentUser);
  // Distinguishes "signed out" from "not yet known", which the UI has to tell
  // apart or it flashes a sign-in prompt at an already signed-in user.
  const authReady = ref(false);
  onAuthStateChanged(auth, (user) => {
    authUser.value = user;
    authReady.value = true;
  });

  return {
    provide: {
      firebaseApp: app,
      firebaseAuth: auth,
      firebaseStorage: getStorage(app),
      firestore: getFirestore(app),
      authUser,
      authReady,
    },
  };
});
