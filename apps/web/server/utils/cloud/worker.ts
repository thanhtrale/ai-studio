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
  buildArmPayload,
  jobTypeById,
  type CloudGalleryDoc,
  type CloudJobDoc,
  type CloudJobProgress,
  type CloudJobResult,
  type CloudWorkerDoc,
  type JobTypeSpec,
} from '@ai-studio/cloud-contract';
import type { JobProgress } from '@ai-studio/arm-contract';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';

import { SupervisorClient } from '../supervisor';
import { cloudAdmin, CloudConfigError } from './admin';

const PROGRESS_POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
const MAX_LOG_LINES = 500;

export type WorkerState = 'stopped' | 'starting' | 'running' | 'error';

export interface WorkerSnapshot {
  state: WorkerState;
  workerId: string;
  configured: boolean;
  currentJobId: string | null;
  arms: string[];
  error: string | null;
  log: string[];
}

export interface WorkerDependencies {
  storageDir: string;
  supervisorUrl: string;
  supervisorToken: string;
}

/** One file the arm produced, however that arm spells it. */
interface ArmOutput {
  outPath: string;
  index: number;
  seed: number | null;
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
 * browser. A signed URL would expire and leave the gallery full of dead links.
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

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads the finished files out of a report.
 *
 * Batch-capable arms list them under their own key; the diffusers arm returns
 * the single path at the top level. Both spellings are the arm's, not ours.
 */
function outputsFrom(spec: JobTypeSpec, report: Record<string, unknown>): ArmOutput[] {
  const listKey = spec.results.listKey;
  if (listKey) {
    const list = report[listKey];
    if (!Array.isArray(list)) return [];
    return list.map((entry, position) => {
      const row = entry as Record<string, unknown>;
      return {
        outPath: String(row['out_path'] ?? ''),
        index: numberOrNull(row['index']) ?? position,
        seed: numberOrNull(row['seed']),
      };
    });
  }

  const single = report['out_path'];
  if (typeof single !== 'string' || !single) return [];
  return [{ outPath: single, index: 0, seed: numberOrNull(report['seed']) }];
}

class CloudWorker {
  #state: WorkerState = 'stopped';
  #error: string | null = null;
  #log: string[] = [];
  #current: string | null = null;
  #arms: string[] = [];
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
      arms: this.#arms,
      error: this.#error,
      log: this.#log,
    };
  }

  #note(line: string) {
    this.#log = [`${new Date().toISOString()} ${line}`, ...this.#log].slice(0, MAX_LOG_LINES);
  }

  #client(): SupervisorClient {
    const deps = this.#deps;
    if (!deps) throw new Error('worker chưa được cấu hình');
    return new SupervisorClient({ baseUrl: deps.supervisorUrl, token: deps.supervisorToken });
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

      await this.#refreshArms();
      await this.#announce('online');
      this.#heartbeat = setInterval(() => void this.#announce('online'), HEARTBEAT_MS);

      // Firestore pushes queued work; nothing polls. A job submitted while the
      // worker was off is already in this result set when it subscribes.
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

  /** Which arms the supervisor has, so the console can grey out the rest. */
  async #refreshArms() {
    try {
      const inventory = await this.#client().inventory();
      this.#arms = inventory.arms.map((arm) => arm.id);
    } catch (cause) {
      this.#arms = [];
      this.#note(`không đọc được danh sách arm: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
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
      arms: this.#arms,
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

  /** Wins the job, or discovers someone else already has it. */
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
    if (!deps || !db) return;

    const reference = db.doc([...JOBS_PATH, job.id].join('/'));
    const runLog: string[] = [];
    const record = (line: string) => {
      runLog.push(`${new Date().toISOString()} ${line}`);
      this.#note(`[${job.id}] ${line}`);
    };

    const spec = jobTypeById(job.typeId);
    if (!spec) {
      await reference.update({
        status: 'failed',
        error: `Không biết loại job ${job.typeId}`,
        endedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return;
    }

    this.#current = job.id;
    const startedAt = Date.now();
    await reference.update({ status: 'running', startedAt, updatedAt: startedAt });
    await this.#announce('online');

    const outRelative = path.posix.join('cloud', `${job.id}.${spec.outputExtension}`);

    try {
      const referencePaths = await this.#fetchReferences(job, spec, deps.storageDir);
      if (referencePaths.length) record(`tải ${referencePaths.length} ảnh tham chiếu về inputs/cloud/`);

      // Coerced again inside: the document was written by a browser, and the arm
      // answers an off-grid value with a 400 rather than a clip.
      const armJob = buildArmPayload(spec, job.values, outRelative, referencePaths);
      record(`gửi job tới arm ${spec.armId}: ${JSON.stringify(armJob)}`);

      const client = this.#client();
      const poller = this.#pollProgress(client, job.id, reference, record);
      let report: Record<string, unknown>;
      try {
        report = await client.job<Record<string, unknown>>(spec.armId, {
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

      await this.#publish(job, spec, report, runLog, startedAt);
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

  #pollProgress(
    client: SupervisorClient,
    jobId: string,
    reference: FirebaseFirestore.DocumentReference,
    record: (line: string) => void,
  ) {
    let last = '';
    return setInterval(() => {
      void (async () => {
        try {
          const { job: progress } = await client.progress(jobId);
          const summary = summarise(progress);
          // Only write when the stage changed or a meter moved, so a long run
          // does not turn into thousands of Firestore writes.
          const key = `${summary.label}:${summary.fraction?.toFixed(2) ?? ''}`;
          if (key === last) return;
          last = key;
          if (summary.label) record(`tiến độ: ${summary.label}`);
          await reference.update({ progress: summary, updatedAt: Date.now() });
        } catch {
          // The supervisor drops a job from memory once it is done; a failure
          // here is not a failure of the run.
        }
      })();
    }, PROGRESS_POLL_MS);
  }

  async #fetchReferences(job: CloudJobDoc, spec: JobTypeSpec, storageDir: string): Promise<string[]> {
    const bucket = this.#bucket;
    if (!bucket || !spec.references) return [];

    const wanted = job.references.slice(0, spec.references.max);
    const relatives: string[] = [];

    for (const [index, entry] of wanted.entries()) {
      const relative = path.posix.join('cloud', `${job.id}-${index}${extensionFor(entry.contentType)}`);
      const target = path.join(storageDir, 'inputs', relative);
      await mkdir(path.dirname(target), { recursive: true });
      const [buffer] = await bucket.file(entry.storagePath).download();
      await writeFile(target, buffer);
      relatives.push(relative);
    }

    return relatives;
  }

  async #publish(
    job: CloudJobDoc,
    spec: JobTypeSpec,
    report: Record<string, unknown>,
    runLog: string[],
    startedAt: number,
  ) {
    const db = this.#db;
    const bucket = this.#bucket;
    const deps = this.#deps;
    if (!db || !bucket || !deps) return;

    const outputs = outputsFrom(spec, report);
    if (!outputs.length) throw new Error('arm không báo tệp nào được tạo');

    const contentType = spec.outputExtension === 'mp4' ? 'video/mp4' : 'image/png';
    const endedAt = Date.now();
    const seconds = numberOrNull(report['seconds_total']) ?? (endedAt - startedAt) / 1000;
    const results: CloudJobResult[] = [];

    for (const output of outputs) {
      // Reports spell the path either way depending on the arm; both resolve
      // against the same managed output root.
      const localPath = path.isAbsolute(output.outPath)
        ? output.outPath
        : path.join(deps.storageDir, 'outputs', output.outPath);
      const info = await stat(localPath);

      const galleryId = outputs.length > 1 ? `${job.id}-${output.index}` : job.id;
      const objectPath = `${STORAGE_OUTPUT_PREFIX}/${galleryId}.${spec.outputExtension}`;
      const token = randomUUID();

      await bucket.upload(localPath, {
        destination: objectPath,
        metadata: { contentType, metadata: { firebaseStorageDownloadTokens: token } },
      });
      runLog.push(`${new Date().toISOString()} đã upload ${objectPath} (${info.size} bytes)`);

      results.push({
        galleryId,
        storagePath: objectPath,
        downloadUrl: downloadUrl(this.#bucketName, objectPath, token),
        bytes: info.size,
        seconds,
        seed: output.seed ?? -1,
      });
    }

    const logUrl = await this.#writeLog(job.id, runLog);
    const logTail = runLog.slice(-INLINE_LOG_TAIL_LINES).join('\n');

    const frames = numberOrNull(report['num_frames']) ?? numberOrNull(job.values['numFrames']);
    const fps = numberOrNull(report['frame_rate']) ?? numberOrNull(job.values['frameRate']) ?? 24;

    for (const [position, result] of results.entries()) {
      const entry: CloudGalleryDoc = {
        id: result.galleryId,
        jobId: job.id,
        typeId: job.typeId,
        armId: job.armId,
        modality: spec.modality,
        createdAt: endedAt,
        createdBy: job.createdBy,
        values: job.values,
        promptUsed: typeof report['prompt_used'] === 'string' ? (report['prompt_used'] as string) : null,
        media: {
          storagePath: result.storagePath,
          downloadUrl: result.downloadUrl,
          contentType,
          bytes: result.bytes,
          width: numberOrNull(report['width']) ?? numberOrNull(job.values['width']),
          height: numberOrNull(report['height']) ?? numberOrNull(job.values['height']),
          durationSeconds: spec.modality === 'video' && frames ? frames / fps : null,
        },
        index: outputs[position]?.index ?? position,
        report,
        logTail,
        logUrl,
        seconds,
      };
      await db.doc([...GALLERY_PATH, result.galleryId].join('/')).set(entry);
    }

    await db.doc([...JOBS_PATH, job.id].join('/')).update({
      status: 'done',
      endedAt,
      updatedAt: endedAt,
      progress: null,
      results,
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
