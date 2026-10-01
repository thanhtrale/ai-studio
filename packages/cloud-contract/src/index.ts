/**
 * The contract between the public web console and the worker running on the
 * studio machine. Firestore is the only thing the two share: the console never
 * reaches the supervisor, and the worker never serves a page.
 *
 * Everything here must survive a JSON round trip through Firestore, so times are
 * epoch milliseconds rather than `Date`, and nothing is optional-by-absence where
 * a null would read better.
 */

export * from './job-types';

/** Collection path under which every document this product writes lives. */
export const CLOUD_ROOT = 'ai-studio';

/** `ai-studio/video/jobs/{jobId}` */
export const JOBS_PATH: [string, string, string] = [CLOUD_ROOT, 'video', 'jobs'];
/** `ai-studio/video/gallery/{itemId}` */
export const GALLERY_PATH: [string, string, string] = [CLOUD_ROOT, 'video', 'gallery'];
/** `ai-studio/video/workers/{workerId}` */
export const WORKERS_PATH: [string, string, string] = [CLOUD_ROOT, 'video', 'workers'];

/** Object key prefixes in Cloud Storage, kept under the same scope as Firestore. */
export const STORAGE_OUTPUT_PREFIX = 'ai-studio/outputs';
export const STORAGE_LOG_PREFIX = 'ai-studio/logs';
export const STORAGE_REF_PREFIX = 'ai-studio/refs';

/** Ceiling on a reference upload, so one pick cannot run away with the bucket. */
export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

/** How many lines of the run log travel inside the gallery document. */
export const INLINE_LOG_TAIL_LINES = 40;

/**
 * `queued` is the only state the console may write. Everything past `claimed`
 * belongs to the worker that holds the claim.
 */
export type CloudJobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled';

export const ACTIVE_JOB_STATUSES: CloudJobStatus[] = ['queued', 'claimed', 'running'];

export interface CloudJobOwner {
  uid: string;
  email: string | null;
  name: string | null;
}

/**
 * The knobs the console exposes are declared per job type in `job-types.ts`.
 * A job carries the type id and a flat bag of values keyed by the arm's own
 * field names, so adding an arm is a data change rather than a schema change.
 */
export interface CloudJobDoc {
  id: string;
  /** Which `JobTypeSpec` this was built from. */
  typeId: string;
  armId: string;
  status: CloudJobStatus;
  /** Keyed by the arm's field names; validated against the spec on both ends. */
  values: Record<string, unknown>;
  references: CloudJobReference[];
  /** Arm start parameters, passed through untouched. */
  armParams: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  createdBy: CloudJobOwner;
  /** Worker id holding the claim, or null while queued. */
  claimedBy: string | null;
  claimedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  progress: CloudJobProgress | null;
  error: string | null;
  /** Incremented on every claim, so a job that keeps crashing can be spotted. */
  attempts: number;
  /** One entry per file the run produced; a batch produces several. */
  results: CloudJobResult[];
}

/** What the console is allowed to put in a new job document. */
export type NewCloudJob = Pick<
  CloudJobDoc,
  'id' | 'typeId' | 'armId' | 'values' | 'references' | 'armParams'
>;

/** The headline a list can show without knowing which arm ran. */
export function jobTitle(job: Pick<CloudJobDoc, 'values'>): string {
  const prompt = job.values['prompt'];
  return typeof prompt === 'string' && prompt.trim() ? prompt.trim() : '(không có prompt)';
}

/**
 * A reference frame, uploaded to Storage before the job document is written.
 *
 * Kept as an object rather than inlined in the document so there is no size
 * ceiling, and so the same upload can be picked again for a later job. The cost
 * is that a reference outlives the job that used it, which a lifecycle rule on
 * the `ai-studio/refs/` prefix is expected to clean up.
 */
export interface CloudJobReference {
  name: string;
  storagePath: string;
  downloadUrl: string;
  contentType: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

/** A coarse progress summary, written at a throttled rate by the worker. */
export interface CloudJobProgress {
  /** 0..1, or null when the stage does not report a proportion. */
  fraction: number | null;
  label: string;
  detail: string | null;
  updatedAt: number;
}

export interface CloudJobResult {
  galleryId: string;
  storagePath: string;
  downloadUrl: string;
  bytes: number;
  seconds: number;
  seed: number;
}

export interface CloudGalleryMedia {
  storagePath: string;
  downloadUrl: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export interface CloudGalleryDoc {
  id: string;
  jobId: string;
  typeId: string;
  armId: string;
  modality: 'video' | 'image';
  createdAt: number;
  createdBy: CloudJobOwner;
  /** The job's values verbatim, so the entry explains how it was made. */
  values: Record<string, unknown>;
  /** What actually reached the model, when the enhancer rewrote the prompt. */
  promptUsed: string | null;
  media: CloudGalleryMedia;
  /** Which file of a batch this is, zero-based. */
  index: number;
  /** The arm's own report, verbatim. */
  report: Record<string, unknown>;
  /**
   * Last lines of the run log. The whole log is an object in Storage because it
   * can outgrow the document limit on a long run.
   */
  logTail: string;
  logUrl: string | null;
  seconds: number;
}

export type WorkerStatus = 'online' | 'offline';

export interface CloudWorkerDoc {
  id: string;
  hostname: string;
  status: WorkerStatus;
  startedAt: number;
  lastSeenAt: number;
  currentJobId: string | null;
  /** Arm ids the supervisor reports as installed, so the console can say which
   * job types are actually runnable on this machine. */
  arms: string[];
  /** Set when the worker stopped on its own rather than being switched off. */
  error: string | null;
}

/**
 * A worker is considered gone once its heartbeat is this stale. The console
 * shows the queue as unattended rather than claiming a job is about to run.
 */
export const WORKER_HEARTBEAT_MS = 15_000;
export const WORKER_STALE_MS = WORKER_HEARTBEAT_MS * 3;

export function isWorkerAlive(worker: Pick<CloudWorkerDoc, 'status' | 'lastSeenAt'>, now = Date.now()): boolean {
  return worker.status === 'online' && now - worker.lastSeenAt < WORKER_STALE_MS;
}
