import { mkdir, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  GALLERY_PATH,
  INLINE_LOG_TAIL_LINES,
  JOBS_PATH,
  STORAGE_LOG_PREFIX,
  STORAGE_OUTPUT_PREFIX,
  WORKERS_PATH,
  type CloudGalleryDoc,
  type CloudJobDoc,
  type CloudJobProgress,
  type CloudVideoSettings,
  type CloudWorkerDoc,
} from '@ai-studio/cloud-contract';
import type { JobProgress } from '@ai-studio/arm-contract';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';

import { SupervisorClient } from '../supervisor';
import { cloudAdmin, CloudConfigError } from './admin';

/** The arm rejects anything that is not a multiple of these. */
const SPATIAL_MULTIPLE = 32;
const TEMPORAL_MULTIPLE = 8;

const PROGRESS_POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
const MAX_LOG_LINES = 500;

export type WorkerState = 'stopped' | 'starting' | 'running' | 'error';

export interface WorkerSnapshot {
  state: WorkerState;
  workerId: string;
  configured: boolean;
  currentJobId: string | null;
  error: string | null;
  log: string[];
}

export interface WorkerDependencies {
  storageDir: string;
  supervisorUrl: string;
  supervisorToken: string;
}

function snapSpatial(value: number): number {
  const clamped = Math.min(1920, Math.max(256, Math.round(value)));
  return Math.round(clamped / SPATIAL_MULTIPLE) * SPATIAL_MULTIPLE;
}

/** The arm requires `8n + 1` frames; anything else is refused outright. */
function snapFrames(seconds: number, frameRate: number): number {
  const raw = Math.round(seconds * frameRate);
  const snapped = Math.round((raw - 1) / TEMPORAL_MULTIPLE) * TEMPORAL_MULTIPLE + 1;
  return Math.min(481, Math.max(9, snapped));
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  return '.jpg';
}

/**
 * Builds the long-lived download URL Firebase itself hands out.
 *
 * The token is unguessable and the document holding it is readable only by a
 * signed-in user, which is the same bargain `getDownloadURL()` makes in the
 * browser. The alternative, a signed URL, expires and would leave the gallery
 * full of dead links.
 */
function downloadUrl(bucketName: string, objectPath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

/** Turns the supervisor's step/meter timeline into the one line the console shows. */
function summarise(progress: JobProgress): CloudJobProgress {
  const meter = progress.meters.find((entry) => entry.total > 0);
  const running = progress.steps.find((step) => step.state === 'running');

  return {
    fraction: meter ? Math.min(1, meter.done / meter.total) : null,
    label: running?.label ?? (progress.state === 'running' ? 'Đang chạy' : progress.state),
    detail: running?.detail ?? meter?.label ?? null,
    updatedAt: Date.now(),
  };
}

class CloudWorker {
  #state: WorkerState = 'stopped';
  #error: string | null = null;
  #log: string[] = [];
  #current: string | null = null;
  #busy = false;

  readonly #id = `${hostname()}-${process.pid}`;

  #db: Firestore | null = null;
  #bucket: Bucket | null = null;
  #bucketName = '';
  #deps: WorkerDependencies | null = null;
  #unsubscribe: (() => void) | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  get snapshot(): WorkerSnapshot {
    return {
      state: this.#state,
      workerId: this.#id,
      configured: Boolean(process.env['AISTUDIO_FIREBASE_SERVICE_ACCOUNT']),
      currentJobId: this.#current,
      error: this.#error,
      log: this.#log,
    };
  }

  #note(line: string) {
    const stamped = `${new Date().toISOString()} ${line}`;
    this.#log = [stamped, ...this.#log].slice(0, MAX_LOG_LINES);
  }

  async start(deps: WorkerDependencies): Promise<WorkerSnapshot> {
    if (this.#state === 'running' || this.#state === 'starting') return this.snapshot;

    this.#state = 'starting';
    this.#error = null;
    try {
      const admin = cloudAdmin();
      this.#db = admin.db;
      this.#bucket = admin.bucket;
      this.#bucketName = admin.bucketName;
      this.#deps = deps;

      await this.#announce('online');
      this.#heartbeat = setInterval(() => void this.#announce('online'), HEARTBEAT_MS);

      // Firestore pushes queued work; nothing polls. A job submitted while the
      // worker was off is simply already in this result set when it subscribes.
      this.#unsubscribe = this.#db
        .collection(JOBS_PATH.join('/'))
        .where('status', '==', 'queued')
        .orderBy('createdAt', 'asc')
        .limit(5)
        .onSnapshot(
          (snapshot) => {
            void this.#drain(snapshot.docs.map((entry) => entry.data() as CloudJobDoc));
          },
          (cause) => {
            this.#error = cause.message;
            this.#state = 'error';
            this.#note(`listener lỗi: ${cause.message}`);
          },
        );

      this.#state = 'running';
      this.#note(`worker ${this.#id} đã bật`);
    } catch (cause) {
      this.#state = 'error';
      this.#error = cause instanceof Error ? cause.message : String(cause);
      this.#note(`không bật được: ${this.#error}`);
      if (!(cause instanceof CloudConfigError)) throw cause;
    }
    return this.snapshot;
  }

  async stop(): Promise<WorkerSnapshot> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;

    if (this.#db) await this.#announce('offline').catch(() => undefined);

    this.#state = 'stopped';
    this.#current = null;
    this.#note('worker đã tắt');
    return this.snapshot;
  }

  async #announce(status: 'online' | 'offline') {
    if (!this.#db) return;
    const doc: CloudWorkerDoc = {
      id: this.#id,
      hostname: hostname(),
      status,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
      currentJobId: this.#current,
      error: this.#error,
    };
    await this.#db.doc([...WORKERS_PATH, this.#id].join('/')).set(doc, { merge: true });
  }

  async #drain(queued: CloudJobDoc[]) {
    // One at a time: the card is exclusive, and the supervisor evicts whatever
    // holds it rather than queueing behind it.
    if (this.#busy || this.#state !== 'running') return;
    const next = queued[0];
    if (!next) return;

    this.#busy = true;
    try {
      if (await this.#claim(next.id)) await this.#run(next);
    } catch (cause) {
      this.#note(`job ${next.id} lỗi: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.#busy = false;
      this.#current = null;
    }
  }

  /** Wins the job or discovers someone else already has it. */
  async #claim(jobId: string): Promise<boolean> {
    const db = this.#db;
    if (!db) return false;
    const reference = db.doc([...JOBS_PATH, jobId].join('/'));

    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(reference);
      const job = snapshot.data() as CloudJobDoc | undefined;
      if (!job || job.status !== 'queued') return false;

      tx.update(reference, {
        status: 'claimed',
        claimedBy: this.#id,
        claimedAt: Date.now(),
        updatedAt: Date.now(),
        attempts: (job.attempts ?? 0) + 1,
      });
      return true;
    });
  }

  async #run(job: CloudJobDoc) {
    const deps = this.#deps;
    const db = this.#db;
    const bucket = this.#bucket;
    if (!deps || !db || !bucket) return;

    this.#current = job.id;
    const reference = db.doc([...JOBS_PATH, job.id].join('/'));
    const runLog: string[] = [];
    const record = (line: string) => {
      runLog.push(`${new Date().toISOString()} ${line}`);
      this.#note(`[${job.id}] ${line}`);
    };

    const client = new SupervisorClient({ baseUrl: deps.supervisorUrl, token: deps.supervisorToken });
    const startedAt = Date.now();
    await reference.update({ status: 'running', startedAt, updatedAt: startedAt });
    await this.#announce('online');

    const settings = job.settings;
    const outRelative = path.posix.join('cloud', `${job.id}.mp4`);
    let imageRelative: string | null = null;

    try {
      if (job.reference) {
        imageRelative = await this.#fetchReference(job, deps.storageDir);
        record(`tải ảnh tham chiếu về ${imageRelative}`);
      }

      const armJob = this.#buildArmJob(job, settings, outRelative, imageRelative);
      record(`gửi job tới arm ${job.armId}: ${JSON.stringify(armJob)}`);

      const poller = this.#pollProgress(client, job.id, reference, record);
      let report: Record<string, unknown>;
      try {
        report = await client.job<Record<string, unknown>>(job.armId, {
          jobId: job.id,
          params: job.armParams,
          job: armJob,
        });
      } finally {
        clearInterval(poller);
      }

      record(`arm trả về: ${JSON.stringify(report)}`);

      const fresh = (await reference.get()).data() as CloudJobDoc | undefined;
      if (fresh?.status === 'canceled') {
        record('job đã bị huỷ trong lúc chạy; bỏ qua kết quả');
        await this.#writeLog(job.id, runLog);
        return;
      }

      await this.#publish(job, report, outRelative, runLog, startedAt);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      record(`thất bại: ${message}`);
      await this.#writeLog(job.id, runLog);
      await reference.update({
        status: 'failed',
        error: message,
        endedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  #buildArmJob(
    job: CloudJobDoc,
    settings: CloudVideoSettings,
    outRelative: string,
    imageRelative: string | null,
  ): Record<string, unknown> {
    return {
      prompt: job.prompt,
      ...(job.negativePrompt ? { negativePrompt: job.negativePrompt } : {}),
      outPath: outRelative,
      ...(imageRelative ? { image: imageRelative } : {}),
      width: snapSpatial(settings.width),
      height: snapSpatial(settings.height),
      numFrames: snapFrames(settings.seconds, settings.frameRate),
      frameRate: settings.frameRate,
      seed: settings.seed,
      enhancePrompt: settings.enhancePrompt,
      spatialUpsample: settings.spatialUpsample,
      temporalUpsample: settings.temporalUpsample,
    };
  }

  #pollProgress(
    client: SupervisorClient,
    jobId: string,
    reference: FirebaseFirestore.DocumentReference,
    record: (line: string) => void,
  ) {
    let lastLabel = '';
    return setInterval(() => {
      void (async () => {
        try {
          const { job: progress } = await client.progress(jobId);
          const summary = summarise(progress);
          // Only write when the stage changed or a meter moved, so a long run
          // does not turn into thousands of Firestore writes.
          const key = `${summary.label}:${summary.fraction?.toFixed(2) ?? ''}`;
          if (key === lastLabel) return;
          lastLabel = key;
          if (summary.label) record(`tiến độ: ${summary.label}`);
          await reference.update({ progress: summary, updatedAt: Date.now() });
        } catch {
          // The supervisor drops a job from memory once it is done; a failure
          // here is not a failure of the run.
        }
      })();
    }, PROGRESS_POLL_MS);
  }

  async #fetchReference(job: CloudJobDoc, storageDir: string): Promise<string> {
    const bucket = this.#bucket;
    if (!bucket || !job.reference) throw new Error('không có ảnh tham chiếu');

    const relative = path.posix.join('cloud', `${job.id}${extensionFor(job.reference.contentType)}`);
    const target = path.join(storageDir, 'inputs', relative);
    await mkdir(path.dirname(target), { recursive: true });

    const [buffer] = await bucket.file(job.reference.storagePath).download();
    await writeFile(target, buffer);
    return relative;
  }

  async #publish(
    job: CloudJobDoc,
    report: Record<string, unknown>,
    outRelative: string,
    runLog: string[],
    startedAt: number,
  ) {
    const db = this.#db;
    const bucket = this.#bucket;
    const deps = this.#deps;
    if (!db || !bucket || !deps) return;

    const localPath = path.join(deps.storageDir, 'outputs', outRelative);
    const info = await stat(localPath);

    const objectPath = `${STORAGE_OUTPUT_PREFIX}/${job.id}.mp4`;
    const token = randomUUID();
    await bucket.upload(localPath, {
      destination: objectPath,
      metadata: {
        contentType: 'video/mp4',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    runLog.push(`${new Date().toISOString()} đã upload ${objectPath} (${info.size} bytes)`);

    const logUrl = await this.#writeLog(job.id, runLog);
    const endedAt = Date.now();
    const galleryId = job.id;

    const gallery: CloudGalleryDoc = {
      id: galleryId,
      jobId: job.id,
      armId: job.armId,
      createdAt: endedAt,
      createdBy: job.createdBy,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      promptUsed: typeof report['prompt_used'] === 'string' ? (report['prompt_used'] as string) : null,
      settings: job.settings,
      media: {
        storagePath: objectPath,
        downloadUrl: downloadUrl(this.#bucketName, objectPath, token),
        contentType: 'video/mp4',
        bytes: info.size,
        width: typeof report['width'] === 'number' ? (report['width'] as number) : job.settings.width,
        height: typeof report['height'] === 'number' ? (report['height'] as number) : job.settings.height,
        durationSeconds: job.settings.seconds,
      },
      report,
      logTail: runLog.slice(-INLINE_LOG_TAIL_LINES).join('\n'),
      logUrl,
      seconds: typeof report['seconds_total'] === 'number' ? (report['seconds_total'] as number) : (endedAt - startedAt) / 1000,
    };

    await db.doc([...GALLERY_PATH, galleryId].join('/')).set(gallery);
    await db.doc([...JOBS_PATH, job.id].join('/')).update({
      status: 'done',
      endedAt,
      updatedAt: endedAt,
      progress: null,
      result: {
        galleryId,
        storagePath: objectPath,
        downloadUrl: gallery.media.downloadUrl,
        bytes: info.size,
        seconds: gallery.seconds,
        seed: typeof report['seed'] === 'number' ? (report['seed'] as number) : job.settings.seed,
      },
    });
  }

  /** The whole log goes to Storage because a long run outgrows a document. */
  async #writeLog(jobId: string, lines: string[]): Promise<string | null> {
    const bucket = this.#bucket;
    if (!bucket) return null;
    try {
      const objectPath = `${STORAGE_LOG_PREFIX}/${jobId}.log`;
      const token = randomUUID();
      await bucket.file(objectPath).save(lines.join('\n'), {
        contentType: 'text/plain; charset=utf-8',
        metadata: { metadata: { firebaseStorageDownloadTokens: token } },
      });
      return downloadUrl(this.#bucketName, objectPath, token);
    } catch {
      return null;
    }
  }
}

let worker: CloudWorker | null = null;

export function cloudWorker(): CloudWorker {
  worker ??= new CloudWorker();
  return worker;
}

export type { CloudWorker };
