/**
 * What a job is doing, while it is doing it.
 *
 * A job crosses three processes -- the browser asks the supervisor, the
 * supervisor brokers the GPU and relays to an arm, the arm runs the model -- and
 * none of them can see the whole of it. This is the shape they agree on: the
 * supervisor contributes the steps it owns (freeing the card, starting the arm),
 * the arm contributes its own, and the supervisor returns them as one list.
 *
 * The shape is deliberately generic. `Denoise` and `Encode prompt` are labels an
 * arm chose, not cases handled here, so an arm for another modality reports its
 * own work without this file changing.
 */

export const JOB_STEP_STATES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStepState = (typeof JOB_STEP_STATES)[number];

export interface JobStep {
  /** Stable within one job; the UI keys off it so a step does not remount. */
  key: string;
  label: string;
  /** The one-line qualifier shown beside the label, e.g. `8 step · 704×704`. */
  detail?: string;
  state: JobStepState;
  /** Elapsed for a finished step; time so far for a running one. */
  seconds?: number;
  /** Free text worth reading in full, such as what the enhancer rewrote. */
  note?: string;
  /** Replaced text, shown struck through above `note`. */
  noteReplaces?: string;
  children?: JobStep[];
}

/** A step with countable work, shown as a bar rather than only a tick. */
export interface JobMeter {
  key: string;
  label: string;
  detail?: string;
  done: number;
  total: number;
}

/** One reading of GPU memory, from whichever of the two meters took it. */
export interface VramSample {
  /** Epoch milliseconds. */
  at: number;
  gib: number;
}

export const JOB_STATES = ['queued', 'running', 'done', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobProgress {
  jobId: string;
  armId: string;
  state: JobState;
  startedAt: number;
  /** Set once the job has finished, either way. */
  endedAt?: number;
  steps: JobStep[];
  meters: JobMeter[];
  /** Why it failed, when it did. */
  detail?: string;
  /**
   * Torch's own reserved figure, sampled inside the arm process.
   *
   * Deliberately not the same measurement as the machine series: this is what
   * one process reserved, that is what the whole card holds. The gap between
   * them is other processes and the driver's own overhead, not a subtraction.
   */
  armVram: VramSample[];
}

export interface GpuTelemetry {
  /** Null when nvidia-smi is not present or stopped answering. */
  totalGib: number | null;
  available: boolean;
  /** Whole-card usage, one reading per second. */
  samples: VramSample[];
}

export interface JobProgressResponse {
  job: JobProgress;
  gpu: GpuTelemetry;
}
