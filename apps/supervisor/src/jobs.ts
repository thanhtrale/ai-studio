import type { JobMeter, JobProgress, JobStep, JobStepState, VramSample } from '@ai-studio/arm-contract';

/**
 * What the supervisor knows about a job while it is in flight.
 *
 * The supervisor owns exactly one step of the timeline -- getting the card into
 * the state the job needs -- and the arm owns the rest. They are kept apart here
 * and joined only when a snapshot is taken, so neither can overwrite the other's
 * work: the arm reports progress on its own clock, and the broker is still
 * writing its own step while the first arm poll arrives.
 */

/** Whatever the arm last reported about the job it is running. */
export interface ArmSnapshot {
  steps: JobStep[];
  meters: JobMeter[];
  vram: VramSample[];
}

const BROKER_STEP_KEY = 'acquire';
const MAX_JOBS = 32;

interface JobRecord {
  jobId: string;
  armId: string;
  startedAt: number;
  endedAt: number | null;
  failed: string | null;
  broker: {
    startedAt: number;
    endedAt: number | null;
    detail: string;
    children: JobStep[];
    state: JobStepState;
  };
  arm: ArmSnapshot | null;
}

export interface JobStoreDeps {
  now?: () => number;
}

export class JobStore {
  readonly #now: () => number;
  #jobs = new Map<string, JobRecord>();

  constructor(deps: JobStoreDeps = {}) {
    this.#now = deps.now ?? Date.now;
  }

  open(jobId: string, armId: string): void {
    const at = this.#now();
    this.#jobs.set(jobId, {
      jobId,
      armId,
      startedAt: at,
      endedAt: null,
      failed: null,
      broker: { startedAt: at, endedAt: null, detail: '', children: [], state: 'running' },
      arm: null,
    });

    // Oldest first, so the cap drops history rather than anything live.
    while (this.#jobs.size > MAX_JOBS) {
      const oldest = this.#jobs.keys().next().value;
      if (oldest === undefined) break;
      this.#jobs.delete(oldest);
    }
  }

  /** What the broker decided, before it acts on it. */
  plan(jobId: string, detail: string): void {
    const record = this.#jobs.get(jobId);
    if (record) record.broker.detail = detail;
  }

  /** One thing the broker did: stopping an arm, starting one, or finding it up. */
  did(jobId: string, key: string, label: string, seconds: number): void {
    const record = this.#jobs.get(jobId);
    if (!record) return;
    record.broker.children.push({ key, label, state: 'done', seconds });
  }

  /** The card is ready; from here the timeline is the arm's. */
  acquired(jobId: string): void {
    const record = this.#jobs.get(jobId);
    if (!record) return;
    record.broker.endedAt = this.#now();
    record.broker.state = 'done';
  }

  arm(jobId: string, snapshot: ArmSnapshot): void {
    const record = this.#jobs.get(jobId);
    if (record) record.arm = snapshot;
  }

  fail(jobId: string, detail: string): void {
    const record = this.#jobs.get(jobId);
    if (!record) return;
    record.failed = detail;
    record.endedAt = this.#now();
    if (record.broker.state === 'running') {
      record.broker.state = 'failed';
      record.broker.endedAt = record.endedAt;
    }
  }

  done(jobId: string): void {
    const record = this.#jobs.get(jobId);
    if (record) record.endedAt = this.#now();
  }

  has(jobId: string): boolean {
    return this.#jobs.has(jobId);
  }

  /** The arm a job is bound to, so a poll knows where to ask. */
  armIdOf(jobId: string): string | undefined {
    return this.#jobs.get(jobId)?.armId;
  }

  get live(): boolean {
    for (const record of this.#jobs.values()) {
      if (record.endedAt === null) return true;
    }
    return false;
  }

  snapshot(jobId: string): JobProgress | undefined {
    const record = this.#jobs.get(jobId);
    if (!record) return undefined;

    const now = this.#now();
    const brokerStep: JobStep = {
      key: BROKER_STEP_KEY,
      label: 'Queued for the card',
      detail: record.broker.detail || undefined,
      state: record.broker.state,
      seconds: ((record.broker.endedAt ?? now) - record.broker.startedAt) / 1000,
      ...(record.broker.children.length > 0 ? { children: record.broker.children } : {}),
    };

    return {
      jobId: record.jobId,
      armId: record.armId,
      state: record.failed !== null ? 'failed' : record.endedAt !== null ? 'done' : record.arm ? 'running' : 'queued',
      startedAt: record.startedAt,
      ...(record.endedAt !== null ? { endedAt: record.endedAt } : {}),
      steps: [brokerStep, ...(record.arm?.steps ?? [])],
      meters: record.arm?.meters ?? [],
      ...(record.failed !== null ? { detail: record.failed } : {}),
      armVram: record.arm?.vram ?? [],
    };
  }
}
