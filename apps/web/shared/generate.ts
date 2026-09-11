/**
 * The contract between the generate console and the web app's own server route.
 *
 * It is not the arm's job schema. The console speaks in library terms -- a
 * reference *media id*, and no output path at all -- and the server turns that
 * into the arm's schema, because deciding where a generation is filed is the
 * library's business rather than the browser's.
 */

import type { JobSettings, MediaItem, OutputInfo } from './library';

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
  settings: JobSettings;
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
