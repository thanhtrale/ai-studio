/**
 * What a survey is doing, while it is doing it.
 *
 * The same decision as the analysis registry: report the arm contract's
 * `JobProgress` rather than a shape of this feature's own, so the console's
 * existing timeline and VRAM chart drive a survey without knowing it is not a
 * generation.
 *
 * What is different is the meters. An analysis is four passes and a reader
 * wants to know which one is running; a survey is a hundred screenshots and
 * nine batches, and "which one" is useless -- what a reader wants is how many
 * of them are left. `JobMeter` is already in the contract for exactly that, so
 * the survey fills it in and the timeline draws bars.
 */

import type {
  JobMeter,
  JobProgress,
  JobState,
  JobStep,
  JobStepState,
  VramSample,
} from '@ai-studio/arm-contract';

import type { SurveyRecord } from '#shared/survey';

export interface SurveyStepSpec {
  key: string;
  label: string;
}

/**
 * The steps of a survey, in the order they happen.
 *
 * Declared up front rather than appended as they begin, so a reader watching a
 * long crawl can see what is still to come, and so a failure leaves the steps
 * it never reached visibly pending rather than absent.
 */
export const SURVEY_STEPS: readonly SurveyStepSpec[] = [
  { key: 'connect', label: 'Reach Figma' },
  { key: 'crawl', label: 'Crawl the file' },
  { key: 'resolve', label: 'Resolve main components' },
  { key: 'shots', label: 'Capture the screens' },
  { key: 'modules', label: 'Group into modules' },
  { key: 'screens', label: 'Describe the screens' },
  { key: 'sections', label: 'Model the sections' },
  { key: 'write', label: 'Save the survey' },
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

/** Fifteen minutes at a sample a second, matching what the console plots. */
const MAX_VRAM_SAMPLES = 900;

export class SurveyRun {
  readonly surveyId: string;
  readonly armId: string;
  readonly startedAt: number;

  #steps: StepState[];
  #meters = new Map<string, JobMeter>();
  #state: JobState = 'queued';
  #endedAt: number | undefined;
  #detail: string | undefined;
  #armVram: VramSample[] = [];
  #now: () => number;

  constructor(
    surveyId: string,
    armId: string,
    steps: readonly SurveyStepSpec[] = SURVEY_STEPS,
    now: () => number = Date.now,
  ) {
    this.surveyId = surveyId;
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
    if (!found) throw new Error(`no survey step named "${key}"`);
    return found;
  }

  start(key: string, detail?: string): void {
    const step = this.#step(key);
    step.state = 'running';
    step.startedAt = this.#now();
    if (detail !== undefined) step.detail = detail;
    if (this.#state === 'queued') this.#state = 'running';
  }

  describe(key: string, detail: string): void {
    this.#step(key).detail = detail;
  }

  note(key: string, note: string): void {
    this.#step(key).note = note;
  }

  done(key: string, note?: string): void {
    const step = this.#step(key);
    step.state = 'done';
    step.endedAt = this.#now();
    if (note !== undefined) step.note = note;
  }

  /** Marks a step as having had nothing to do. Not a failure, and not work. */
  skip(key: string, why: string): void {
    const step = this.#step(key);
    step.state = 'done';
    step.detail = why;
    step.endedAt = this.#now();
  }

  /**
   * Countable work, shown as a bar.
   *
   * Keyed by the step it belongs to, so a meter replaces itself rather than
   * accumulating a row per update.
   */
  meter(key: string, label: string, done: number, total: number): void {
    this.#meters.set(key, { key, label, done, total });
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

  finish(): void {
    if (this.#state === 'failed') return;
    this.#state = 'done';
    this.#endedAt = this.#now();
  }

  /** Grafts a supervisor job's progress under a step. See the analysis registry. */
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

  progress(): JobProgress {
    const now = this.#now();

    const steps: JobStep[] = this.#steps.map((step) => {
      const entry: JobStep = { key: step.key, label: step.label, state: step.state };
      if (step.detail !== undefined) entry.detail = step.detail;
      if (step.note !== undefined) entry.note = step.note;
      if (step.children !== undefined) entry.children = step.children;
      if (step.startedAt !== undefined) {
        entry.seconds = ((step.endedAt ?? now) - step.startedAt) / 1000;
      }
      return entry;
    });

    const progress: JobProgress = {
      jobId: this.surveyId,
      armId: this.armId,
      state: this.#state,
      startedAt: this.startedAt,
      steps,
      meters: [...this.#meters.values()],
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
 * Module state, so it does not survive a Nuxt reload -- which is why the store
 * writes the record before the crawl starts and the inventory as soon as it
 * ends. A run that is on disk but not in here is reported from its record.
 */
const runs = new Map<string, SurveyRun>();

export function createSurveyRun(surveyId: string, armId: string): SurveyRun {
  const run = new SurveyRun(surveyId, armId);
  runs.set(surveyId, run);
  return run;
}

export function getSurveyRun(surveyId: string): SurveyRun | undefined {
  return runs.get(surveyId);
}

export function forgetSurveyRun(surveyId: string): void {
  runs.delete(surveyId);
}

/** Test seam: the registry is module state and a test must be able to empty it. */
export function clearSurveyRuns(): void {
  runs.clear();
}

const INTERRUPTED =
  'the web application restarted while this survey was running, so it did not finish. ' +
  'Whatever the crawl had already found was saved';

/**
 * The timeline of a survey that is on disk but not in the registry.
 *
 * A record still saying "running" with no run behind it is a run that died, and
 * it is reported as failed rather than as a spinner that will never stop.
 */
export function surveyProgressFromRecord(record: SurveyRecord): JobProgress {
  const interrupted = record.state === 'queued' || record.state === 'running';
  const state: JobState = interrupted ? 'failed' : record.state;

  const stepState: JobStepState = state === 'done' ? 'done' : 'pending';
  const steps: JobStep[] = SURVEY_STEPS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    state: stepState,
  }));

  const progress: JobProgress = {
    jobId: record.surveyId,
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
