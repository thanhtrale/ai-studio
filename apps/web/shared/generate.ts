/**
 * The contract between the generate console and the web app's own server route.
 *
 * It is not the arm's job schema. The console speaks in library terms -- a
 * reference *media id*, and no output path at all -- and the server turns that
 * into the arm's schema, because deciding where a generation is filed is the
 * library's business rather than the browser's.
 */

import type { ImageJobSettings, MediaItem, OutputInfo, VideoJobSettings } from './library';

export interface GenerateRequest {
  /**
   * Chosen by the browser, not returned to it.
   *
   * The console has to be able to ask about a job while the request that
   * submitted it is still open -- a clip is minutes long -- so the id cannot
   * arrive with the response.
   */
  jobId: string;
  prompt: string;
  negativePrompt?: string;
  /** A media id under the arm input root, for image-to-video. */
  referenceId?: string;
  settings: VideoJobSettings;
  /** What the console worked out the result will be, after the upsamplers. */
  output: OutputInfo;
  /**
   * How the arm must be configured to run this.
   *
   * Start parameters decide how weights are placed and cannot change without
   * reloading them, so they belong to the job rather than to a separate act of
   * starting an arm -- which the user never performs.
   */
  armParams?: Record<string, unknown>;
}

/** The arm's own report, verbatim: its keys are the arm's, not the console's. */
export interface ArmGenerationReport {
  seconds_total: number;
  seconds_encode_prompt: number;
  seconds_per_step: number[];
  steps: number;
  seed: number;
  /** What reached the model, which differs from the request when the enhancer ran. */
  prompt_used?: string;
  out_path: string;
  out_bytes: number;
  peak_vram_allocated_gib: number;
  peak_vram_reserved_gib: number;
  peak_host_rss_gib: number;
  stages: { name: string; seconds: number; peak_vram_gib: number; spill_gib: number }[];
}

export interface GenerateResponse {
  /** The library entry that now exists, record and all. */
  media: MediaItem;
  report: ArmGenerationReport;
}

/**
 * The image console's request.
 *
 * Separate from the video one rather than a modality flag on it, because the
 * two share almost nothing: no duration, no upsamplers, no enhancer, and a
 * batch that turns one request into several files. What they do share -- a
 * browser-chosen job id, a reference by media id, arm start parameters -- is
 * spelled the same way on purpose.
 */
export interface ImageGenerateRequest {
  jobId: string;
  prompt: string;
  /**
   * The style half of the prompt, joined onto `prompt` before it is sent.
   *
   * Two boxes rather than one because the two halves change at different
   * rates: a style is settled once and reused across a session, and a subject
   * is rewritten every run. Splitting them is a convenience of the form only —
   * the model is given one prompt, and anyone who prefers to write it as one
   * can leave this empty.
   */
  stylePrompt?: string;
  negativePrompt?: string;
  /**
   * Ask the arm to rewrite the prompt before it samples.
   *
   * Only some arms have a rewriter; one that does not ignores this, which is
   * why it is a plain flag rather than something the console has to negotiate.
   * What actually reached the model comes back as the report's `prompt_used`.
   */
  enhancePrompt?: boolean;
  /**
   * Media ids under the arm input root. Plural because Qwen-Image-Edit takes
   * several: the references are composed into one scene rather than being
   * alternatives to choose between.
   */
  referenceIds?: string[];
  /**
   * A folder under `outputs/` to file this run in, instead of today's date.
   *
   * A long scripted run is one body of work, and splitting it across date
   * folders -- or mixing it into whatever else was made that day -- is what
   * makes it unreadable afterwards.
   */
  collection?: string;
  settings: ImageJobSettings;
  output: OutputInfo;
  armParams?: Record<string, unknown>;
}

/**
 * The one prompt the model is given, out of the console's two boxes.
 *
 * Subject first, style after: an empty half must leave no trace, and joining
 * on a comma is what a reader of either half would have typed had they written
 * the whole thing in one box.
 */
export function mergePrompt(subject: string, style?: string): string {
  return [subject, style]
    .map((part) => (part ?? '').trim().replace(/[,\s]+$/, ''))
    .filter((part) => part.length > 0)
    .join(', ');
}

/** One file out of a batch, as the arm reports it. */
export interface ArmImageOut {
  out_path: string;
  out_bytes: number;
  index: number;
  seed: number;
}

/** The image arm's own report, verbatim: its keys are the arm's, not the console's. */
export interface ArmImageReport {
  seconds_total: number;
  steps: number;
  seed: number;
  batch: number;
  width: number;
  height: number;
  images: ArmImageOut[];
  peak_vram_gib: number;
  /**
   * What `peak_vram_gib` measured.
   *
   * `process` is this arm's own share, the same thing the video arm reports.
   * `card` is the whole GPU, which is all a GeForce card under Windows will
   * say -- the driver owns the allocations and reports `[N/A]` per process.
   * Carried rather than assumed, because filing a whole-card peak as one arm's
   * share overstates it by whatever else was on the card.
   */
  vram_scope: 'process' | 'card' | 'unavailable';
  stages: { name: string; seconds: number }[];
  prompt_used?: string | null;
}

export interface ImageGenerateResponse {
  /** One entry per file written, in the order the arm produced them. */
  media: MediaItem[];
  report: ArmImageReport;
}
