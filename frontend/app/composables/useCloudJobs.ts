import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  JOBS_PATH,
  VIDEO_ARM_ID,
  WORKERS_PATH,
  isWorkerAlive,
  type CloudJobDoc,
  type CloudJobReference,
  type CloudVideoSettings,
  type CloudWorkerDoc,
} from '@ai-studio/cloud-contract';

export interface JobSubmission {
  prompt: string;
  negativePrompt: string;
  settings: CloudVideoSettings;
  reference: CloudJobReference | null;
}

export function useCloudJobs() {
  const nuxt = useNuxtApp();
  const { owner } = useAuth();

  const jobs = ref<CloudJobDoc[]>([]);
  const workers = ref<CloudWorkerDoc[]>([]);
  const error = ref<string | null>(null);
  const pending = ref(true);

  // Re-evaluated on a timer because liveness is a function of wall clock, not of
  // any document change: a worker that dies stops writing, so nothing arrives to
  // trigger a recompute.
  const now = ref(Date.now());
  const workerOnline = computed(() => workers.value.some((w) => isWorkerAlive(w, now.value)));

  let unsubscribes: Unsubscribe[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;

  function db(): Firestore {
    const instance = nuxt.$firestore as Firestore | undefined;
    if (!instance) throw new Error('Firebase chưa được cấu hình (thiếu NUXT_PUBLIC_FIREBASE_*)');
    return instance;
  }

  function subscribe() {
    try {
      const jobsQuery = query(collection(db(), ...JOBS_PATH), orderBy('createdAt', 'desc'), limit(50));
      unsubscribes.push(
        onSnapshot(
          jobsQuery,
          (snapshot) => {
            jobs.value = snapshot.docs.map((entry) => entry.data() as CloudJobDoc);
            pending.value = false;
          },
          (cause) => {
            error.value = cause.message;
            pending.value = false;
          },
        ),
        onSnapshot(collection(db(), ...WORKERS_PATH), (snapshot) => {
          workers.value = snapshot.docs.map((entry) => entry.data() as CloudWorkerDoc);
        }),
      );
      ticker = setInterval(() => (now.value = Date.now()), 5000);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      pending.value = false;
    }
  }

  async function submit(input: JobSubmission): Promise<string> {
    const createdBy = owner.value;
    if (!createdBy) throw new Error('Chưa đăng nhập');

    const reference = doc(collection(db(), ...JOBS_PATH));
    const at = Date.now();
    const payload: CloudJobDoc = {
      id: reference.id,
      armId: VIDEO_ARM_ID,
      status: 'queued',
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      settings: input.settings,
      reference: input.reference,
      armParams: {},
      createdAt: at,
      updatedAt: at,
      createdBy,
      claimedBy: null,
      claimedAt: null,
      startedAt: null,
      endedAt: null,
      progress: null,
      error: null,
      attempts: 0,
      result: null,
    };

    await setDoc(reference, payload);
    return reference.id;
  }

  /**
   * Marks the job cancelled and leaves it there. A running job keeps running —
   * the worker notices the flag between steps; nothing here can reach into the
   * GPU and stop it mid-tensor.
   */
  async function cancel(id: string) {
    await updateDoc(doc(db(), ...JOBS_PATH, id), { status: 'canceled', updatedAt: Date.now() });
  }

  async function remove(id: string) {
    await deleteDoc(doc(db(), ...JOBS_PATH, id));
  }

  onMounted(subscribe);
  onBeforeUnmount(() => {
    for (const stop of unsubscribes) stop();
    unsubscribes = [];
    if (ticker) clearInterval(ticker);
  });

  return { jobs, workers, workerOnline, error, pending, submit, cancel, remove };
}
