/**
 * The contract between the generate console and the web app's own server route.
 *
 * It is not the arm's job schema. The console speaks in library terms -- a
 * reference *media id*, and no output path at all -- and the server turns that
 * into the arm's schema, because deciding where a generation is filed is the
 * library's business rather than the browser's.
 */

import type {
  ImageJobSettings,
  MediaItem,
  ModelJobSettings,
  OutputInfo,
  RigJobSettings,
  VideoJobSettings,
  VideoMode,
} from './library';

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
 * The video console's request to a ComfyUI video arm.
 *
 * Separate from `GenerateRequest` rather than a widening of it, because the two
 * arms behind this console are not the same shape: the fixed-schedule diffusers
 * arm has upsamplers, an enhancer and exactly one clip per request, and the
 * distilled ComfyUI arm has a step count, a scheduler, two keyframes and a
 * batch. What they share -- a browser-chosen job id, references by media id,
 * arm start parameters -- is spelled the same way on purpose, and this one is
 * spelled the same way as `ImageGenerateRequest` for the same reason.
 */
export interface VideoGenerateRequest {
  jobId: string;
  prompt: string;
  /** The style half of the prompt, joined onto `prompt` before it is sent. */
  stylePrompt?: string;
  negativePrompt?: string;
  /**
   * Media ids under the arm input root. In `fl2v` they are positional: the
   * first is the clip's first frame and the second its last, so sending one
   * image to end on means sending it in the second slot. In `ref2v` they are
   * `<Picture 1>` ... `<Picture 9>`, in the order the prompt numbers them.
   */
  referenceIds?: string[];
  /** A folder under `outputs/` to file this run in, instead of today's date. */
  collection?: string;
  /** Carries `mode` and `refImageSize`, which the route passes to the arm. */
  settings: VideoJobSettings;
  output: OutputInfo;
  armParams?: Record<string, unknown>;
}

/** One clip out of a batch, as the arm reports it. */
export interface ArmVideoOut {
  out_path: string;
  out_bytes: number;
  index: number;
  seed: number;
}

/** The ComfyUI video arm's own report, verbatim: its keys are the arm's. */
export interface ArmVideoReport {
  seconds_total: number;
  steps: number;
  seed: number;
  batch: number;
  width: number;
  height: number;
  num_frames: number;
  frame_rate: number;
  videos: ArmVideoOut[];
  peak_vram_gib: number;
  /** What `peak_vram_gib` measured. See `ArmImageReport` for why it travels. */
  vram_scope: 'process' | 'card' | 'unavailable';
  stages: { name: string; seconds: number }[];
  prompt_used?: string | null;
}

export interface VideoGenerateResponse {
  /** One entry per file written, in the order the arm produced them. */
  media: MediaItem[];
  report: ArmVideoReport;
}

/**
 * Ask a vision-language arm to rewrite a MiniMax-H3 prompt.
 *
 * Its own request rather than a flag on the generate one: the rewrite runs on
 * a different arm, the user reads and edits what comes back before anything
 * is sampled, and a clip is minutes -- too long to spend on a prompt nobody
 * has seen.
 */
export interface VideoEnhanceRequest {
  /** Browser-chosen, so the console can follow the rewrite on its timeline. */
  jobId: string;
  mode: VideoMode;
  /** The prompt as it stands. May be empty when the note and images are enough. */
  prompt: string;
  /** What the user wants changed. May be empty: then the rewrite only reshapes. */
  comment: string;
  /** Media ids, in the same order the generate request will send them. */
  referenceIds?: string[];
  /** The clip as it will be asked for, so the rewrite's timeline adds up. */
  seconds: number;
  width: number;
  height: number;
  /** Which `text.vision` arm to use. The first one discovered when absent. */
  armId?: string;
}

export interface VideoEnhanceResponse {
  prompt: string;
  armId: string;
  /** Seconds the rewrite took, including any model swap the supervisor made. */
  secondsTotal: number;
  /**
   * `<Picture N>` tags in a ref2v rewrite that have no image behind them. The
   * console says so rather than letting a clip be sampled against nothing.
   */
  danglingTags: number[];
  /**
   * Dialogue the user put in double quotes that the rewrite does not carry
   * word for word -- translated, reworded or dropped. Quoted lines are kept
   * verbatim by rule, and this is the check that the rule held.
   */
  missingQuotes: string[];
  /**
   * Sections of H3's prompt format the rewrite left out: the three fl2v
   * fields, or the six ref2v ones. A prompt missing one is not the format
   * the model was trained on.
   */
  missingSections: string[];
}

/**
 * Ask a vision-language arm to rewrite a Qwen-Image 2.1 prompt.
 *
 * The image counterpart of `VideoEnhanceRequest`, and its own request for the
 * same reasons: the rewrite runs on a different arm and comes back into the
 * prompt box to be read before anything is sampled.
 */
export interface ImageEnhanceRequest {
  jobId: string;
  /** The prompt as it stands. May be empty when the note and images are enough. */
  prompt: string;
  /** What the user wants changed. May be empty: then the rewrite only expands. */
  comment: string;
  /** Media ids, in the order the generate request will send them. Any makes it an edit. */
  referenceIds?: string[];
  /** The frame, so a text-to-image rewrite is told the ratio it is writing for. */
  width: number;
  height: number;
  /** Which `text.vision` arm to use. The first one discovered when absent. */
  armId?: string;
}

export interface ImageEnhanceResponse {
  prompt: string;
  armId: string;
  secondsTotal: number;
  /**
   * Text the user put in double quotes that the rewrite does not carry word
   * for word. Quoted text is what gets painted into the image, and the
   * rewriter is told to copy it exactly; this is the check that it did.
   */
  missingQuotes: string[];
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

/**
 * One photograph in, one or more GLB files out.
 *
 * No prompt: Hunyuan3D is conditioned on the image alone. `prompt` in the
 * library record is a free-text note of what the object is, kept so a mesh can
 * be found again by what it shows.
 */
export interface MeshGenerateRequest {
  jobId: string;
  referenceId: string;
  note?: string;
  collection?: string;
  settings: ModelJobSettings;
  armParams?: Record<string, unknown>;
}

export interface ArmMeshOut {
  out_path: string;
  out_bytes: number;
  index: number;
  seed: number;
  vertices: number | null;
  faces: number | null;
  /** Only the TRELLIS.2 arm reports it; Hunyuan3D's meshes never are. */
  textured?: boolean;
  /** What the maps weighed before and after WebP; both 0 when left alone. */
  texture_bytes_before?: number;
  texture_bytes_after?: number;
}

export interface ArmMeshReport {
  seconds_total: number;
  steps: number;
  seed: number;
  batch: number;
  meshes: ArmMeshOut[];
  peak_vram_gib: number;
  vram_scope: 'process' | 'card' | 'unavailable';
  stages: { name: string; seconds: number }[];
}

export interface MeshGenerateResponse {
  media: MediaItem[];
  report: ArmMeshReport;
}

/** A mesh from the library in, the same mesh rigged and animated out. */
export interface RigGenerateRequest {
  jobId: string;
  /** The mesh to rig: a `.glb` in the library. */
  meshId: string;
  note?: string;
  collection?: string;
  settings: RigJobSettings;
}

export interface ArmRigReport {
  seconds_total: number;
  out_path: string;
  out_bytes: number;
  bones: number;
  vertices: number;
  faces: number;
  clips: string[];
  peak_vram_gib: number;
  vram_scope: 'process' | 'card' | 'unavailable';
  texture_bytes_before: number;
  texture_bytes_after: number;
  stages: { name: string; seconds: number }[];
}

export interface RigGenerateResponse {
  media: MediaItem[];
  report: ArmRigReport;
}
