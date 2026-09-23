/**
 * What an analysis is doing, while it is doing it.
 *
 * A generation's timeline is assembled by the supervisor from steps an arm
 * reported. An analysis has steps no arm can see -- reaching Figma, parsing a
 * ticket, four model passes -- because its logic lives here rather than in an
 * arm. So the web application keeps its own registry.
 *
 * It reports the `JobProgress` shape from the arm contract rather than a type
 * of its own, and that is the decision worth naming. `JobStep` is already
 * generic: its labels are the producer's, not cases the contract handles. An
 * analysis is simply a producer that is not an arm, and reusing the shape is
 * what lets `JobTimeline.vue` render one unchanged instead of growing a second
 * timeline component with the same states, nesting and duration formatting.
 *
 * Each model pass is a real supervisor job, and while one runs its own progress
 * is grafted in as the children of that pass's step -- so the timeline shows
 * "Pass 3 · Reconcile" with the arm's "Prompt processing" and "Answer" beneath
 * it, rather than a spinner that cannot tell thinking from a hang.
 */

import type { JobProgress, JobState, JobStep, JobStepState, VramSample } from '@ai-studio/arm-contract';

import type { AnalysisRecord } from '#shared/analysis';

/** A step declared before the run starts, so the timeline shows what is coming. */
export interface AnalysisStepSpec {
  key: string;
  label: string;
}

/**
 * The steps of an analysis, in the order they happen.
 *
 * Declared up front rather than appended as they begin: a reader watching a
 * four-minute run should be able to see that there are four passes and which
 * one is current, and a failure has to leave the steps it never reached
 * visibly pending rather than absent.
 */
export const ANALYSIS_STEPS: readonly AnalysisStepSpec[] = [
  { key: 'design', label: 'Read the design' },
  { key: 'ticket', label: 'Read the ticket' },
  { key: 'pass1', label: 'Pass 1 · Design inventory' },
  { key: 'pass2', label: 'Pass 2 · Ticket claims' },
  { key: 'pass3', label: 'Pass 3 · Reconcile' },
  { key: 'pass4', label: 'Pass 4 · Content model' },
  { key: 'write', label: 'Write the artefacts' },
];

interface StepState {
  key: string;
  label: string;
  state: JobStepState;
  detail?: string;
  note?: string;
  startedAt?: number;
  endedAt?: number;
  children?: JobStep[];
}

/** Fifteen minutes at a sample a second, matching what the console will plot. */
const MAX_VRAM_SAMPLES = 900;

export class AnalysisRun {
  readonly analysisId: string;
  readonly armId: string;
  readonly startedAt: number;

  #steps: StepState[];
  #state: JobState = 'queued';
  #endedAt: number | undefined;
  #detail: string | undefined;
  #armVram: VramSample[] = [];
  #now: () => number;

  constructor(
    analysisId: string,
    armId: string,
    steps: readonly AnalysisStepSpec[] = ANALYSIS_STEPS,
    now: () => number = Date.now,
  ) {
    this.analysisId = analysisId;
    this.armId = armId;
    this.#now = now;
    this.startedAt = now();
    this.#steps = steps.map((spec) => ({ key: spec.key, label: spec.label, state: 'pending' }));
  }

  get state(): JobState {
    return this.#state;
  }

  #step(key: string): StepState {
    const found = this.#steps.find((step) => step.key === key);
    // A typo in a step key would otherwise be a silent no-op, and the timeline
    // would just never advance.
    if (!found) throw new Error(`no analysis step named "${key}"`);
    return found;
  }

  /** Marks a step running. The run becomes running with its first step. */
  start(key: string, detail?: string): void {
    const step = this.#step(key);
    step.state = 'running';
    step.startedAt = this.#now();
    if (detail !== undefined) step.detail = detail;
    if (this.#state === 'queued') this.#state = 'running';
  }

  /** The one-line qualifier beside a step's label. */
  describe(key: string, detail: string): void {
    this.#step(key).detail = detail;
  }

  /** Free text worth reading in full, such as what a pass actually found. */
  note(key: string, note: string): void {
    this.#step(key).note = note;
  }

  done(key: string, note?: string): void {
    const step = this.#step(key);
    step.state = 'done';
    step.endedAt = this.#now();
    if (note !== undefined) step.note = note;
  }

  /**
   * Fails a step, and with it the run.
   *
   * Steps that were never reached stay pending rather than being marked
   * failed: they did not fail, they did not happen, and the difference is what
   * tells a reader how far the run got.
   */
  fail(key: string, reason: string): void {
    const step = this.#step(key);
    step.state = 'failed';
    step.endedAt = this.#now();
    this.#state = 'failed';
    this.#endedAt = this.#now();
    this.#detail = reason;
  }

  /** Ends the run successfully. */
  finish(): void {
    if (this.#state === 'failed') return;
    this.#state = 'done';
    this.#endedAt = this.#now();
  }

  /**
   * Grafts a supervisor job's progress under a step.
   *
   * The arm's steps become this step's children, and the arm's own VRAM series
   * is carried through so the console's chart keeps working during a pass. The
   * arm's top-level state is deliberately not copied: whether the *analysis*
   * failed is this registry's judgement, not one pass's.
   */
  graft(key: string, progress: Pick<JobProgress, 'steps' | 'armVram'>): void {
    const step = this.#step(key);
    step.children = progress.steps;
    if (progress.armVram.length === 0) return;

    const known = this.#armVram.at(-1)?.at ?? -Infinity;
    const fresh = progress.armVram.filter((sample) => sample.at > known);
    if (fresh.length > 0) {
      this.#armVram = [...this.#armVram, ...fresh].slice(-MAX_VRAM_SAMPLES);
    }
  }

  /** The timeline, as the console reads it. */
  progress(): JobProgress {
    const now = this.#now();

    const steps: JobStep[] = this.#steps.map((step) => {
      const entry: JobStep = { key: step.key, label: step.label, state: step.state };
      if (step.detail !== undefined) entry.detail = step.detail;
      if (step.note !== undefined) entry.note = step.note;
      if (step.children !== undefined) entry.children = step.children;
      if (step.startedAt !== undefined) {
        // Elapsed for a finished step; time so far for a running one.
        entry.seconds = ((step.endedAt ?? now) - step.startedAt) / 1000;
      }
      return entry;
    });

    const progress: JobProgress = {
      jobId: this.analysisId,
      armId: this.armId,
      state: this.#state,
      startedAt: this.startedAt,
      steps,
      meters: [],
      armVram: this.#armVram,
    };
    if (this.#endedAt !== undefined) progress.endedAt = this.#endedAt;
    if (this.#detail !== undefined) progress.detail = this.#detail;
    return progress;
  }
}

/**
 * Runs in flight, by id.
 *
 * Module state, so it does not survive a Nuxt reload -- which is exactly why
 * the store writes an analysis's sources to disk before the first pass. A run
 * that is on disk but not in here is reported as failed rather than as still
 * running; see the progress route.
 */
const runs = new Map<string, AnalysisRun>();

export function createRun(
  analysisId: string,
  armId: string,
  steps: readonly AnalysisStepSpec[] = ANALYSIS_STEPS,
): AnalysisRun {
  const run = new AnalysisRun(analysisId, armId, steps);
  runs.set(analysisId, run);
  return run;
}

export function getRun(analysisId: string): AnalysisRun | undefined {
  return runs.get(analysisId);
}

export function forgetRun(analysisId: string): void {
  runs.delete(analysisId);
}

/** Test seam: the registry is module state and a test must be able to empty it. */
export function clearRuns(): void {
  runs.clear();
}

/**
 * Why a record can be on disk with nothing running it.
 *
 * Module state dies with the process, and in development every edit reloads
 * Nuxt. The run is gone; the record it wrote before its first pass is not.
 */
const INTERRUPTED =
  'the web application restarted while this analysis was running, so it did not finish';

/**
 * The timeline of an analysis that is on disk but not in the registry.
 *
 * Per-step timings are not reconstructed -- they were never written down, and
 * inventing them would be worse than their absence. What this does settle is
 * the one thing a reader must not be misled about: a record still saying
 * "running" with no run behind it is a run that died, and it is reported as
 * failed rather than as a spinner that will never stop.
 */
export function progressFromRecord(record: AnalysisRecord): JobProgress {
  const interrupted = record.state === 'queued' || record.state === 'running';
  const state: JobState = interrupted ? 'failed' : record.state;

  const stepState: JobStepState = state === 'done' ? 'done' : 'pending';
  const steps: JobStep[] = ANALYSIS_STEPS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    state: stepState,
  }));

  const progress: JobProgress = {
    jobId: record.analysisId,
    armId: record.armId,
    state,
    startedAt: Date.parse(record.startedAt),
    steps,
    meters: [],
    armVram: [],
  };

  const endedAt = record.endedAt ? Date.parse(record.endedAt) : undefined;
  if (endedAt !== undefined && Number.isFinite(endedAt)) progress.endedAt = endedAt;

  const detail = interrupted ? INTERRUPTED : record.detail;
  if (detail !== undefined) progress.detail = detail;

  return progress;
}
