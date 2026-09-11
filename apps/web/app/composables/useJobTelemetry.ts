import type { GpuTelemetry, JobProgress, JobProgressResponse, VramSample } from '@ai-studio/arm-contract';

/**
 * The right-hand column's data: what the card holds, and what the job is doing.
 *
 * The machine meter runs whether or not a job does -- the card is not idle just
 * because this studio is, and seeing what was already on it before a run is half
 * the value of the chart. The job poll only runs while there is a job.
 */
const GPU_INTERVAL_MS = 1000;
const JOB_INTERVAL_MS = 700;
/** Fifteen minutes at a sample a second. Enough for any run this card can finish. */
const MAX_SAMPLES = 900;

export function useJobTelemetry() {
  const job = ref<JobProgress | null>(null);
  const machine = ref<VramSample[]>([]);
  const capacityGib = ref<number | null>(null);
  const available = ref(true);
  const now = ref(Date.now());

  const armVram = computed<VramSample[]>(() => job.value?.armVram ?? []);

  const elapsedSeconds = computed(() => {
    const current = job.value;
    if (!current) return 0;
    return ((current.endedAt ?? now.value) - current.startedAt) / 1000;
  });

  let jobId: string | null = null;
  let gpuTimer: ReturnType<typeof setInterval> | undefined;
  let jobTimer: ReturnType<typeof setInterval> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  function absorb(telemetry: GpuTelemetry): void {
    capacityGib.value = telemetry.totalGib;
    available.value = telemetry.available;
    if (telemetry.samples.length === 0) return;

    const known = machine.value.at(-1)?.at ?? -Infinity;
    const fresh = telemetry.samples.filter((sample) => sample.at > known);
    if (fresh.length === 0) return;

    machine.value = [...machine.value, ...fresh].slice(-MAX_SAMPLES);
  }

  async function pollGpu(): Promise<void> {
    // Asking only for what is new keeps a long run's payload flat rather than
    // resending the whole series every second.
    const since = machine.value.at(-1)?.at;
    try {
      absorb(await $fetch<GpuTelemetry>('/api/gpu', { query: since ? { since } : {} }));
    } catch {
      available.value = false;
    }
  }

  async function pollJob(): Promise<void> {
    if (!jobId) return;
    try {
      const answer = await $fetch<JobProgressResponse>(`/api/jobs/${encodeURIComponent(jobId)}`);
      job.value = answer.job;
      absorb(answer.gpu);
      // A finished job stops being polled, but the chart keeps running: the
      // card does not empty the moment a clip is written.
      if (answer.job.state === 'done' || answer.job.state === 'failed') stopWatching();
    } catch {
      // The job may not be registered yet -- the submit and the first poll race
      // by a few milliseconds. Keep asking.
    }
  }

  /** Follow a job that has just been submitted. */
  function watch(id: string): void {
    if (!import.meta.client) return;
    stopWatching();
    jobId = id;
    job.value = null;
    // The chart is per run: what the card held during the last one is not this
    // one's shape, and the peak chips would read the wrong number.
    machine.value = [];
    void pollJob();
    jobTimer = setInterval(() => void pollJob(), JOB_INTERVAL_MS);
  }

  function stopWatching(): void {
    if (jobTimer) clearInterval(jobTimer);
    jobTimer = undefined;
    jobId = null;
  }

  onMounted(() => {
    void pollGpu();
    gpuTimer = setInterval(() => void pollGpu(), GPU_INTERVAL_MS);
    tick = setInterval(() => (now.value = Date.now()), 200);
  });

  onBeforeUnmount(() => {
    if (gpuTimer) clearInterval(gpuTimer);
    if (tick) clearInterval(tick);
    stopWatching();
  });

  return { job, machine, armVram, capacityGib, available, elapsedSeconds, watch, stopWatching };
}
