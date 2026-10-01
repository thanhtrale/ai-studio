/**
 * The arithmetic behind the frame and duration controls.
 *
 * Kept out of the component because it is the part with answers that can be
 * wrong: the model rejects sizes that are not multiples of 32 and frame counts
 * that are not `8n+1`, so the console has to round before it asks rather than
 * let the arm reject the job.
 */

export const SPATIAL_MULTIPLE = 32;
export const TEMPORAL_MULTIPLE = 8;

export const ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export type Aspect = (typeof ASPECTS)[number];

export interface Frame {
  width: number;
  height: number;
  /** What the rounded size actually comes to, which is rarely the request. */
  megapixels: number;
  ratio: number;
}

/** No model here is worth asking for a frame smaller than this. */
export const MIN_EDGE = 256;

/** Past this the card is the limit, not the model. */
export const MAX_EDGE = 4096;

const snap = (value: number, multiple: number, min: number): number =>
  Math.max(min, Math.round(value / multiple) * multiple);

export function aspectRatio(aspect: Aspect): number {
  const [w, h] = aspect.split(':').map(Number);
  return (w ?? 1) / (h ?? 1);
}

/**
 * Height is solved from the pixel budget and rounded first, then width follows
 * from the rounded height. Rounding both independently drifts the ratio further:
 * for 16:9 at 0.5 MP that is the difference between 928x544 and 960x544.
 *
 * Takes a ratio rather than a named aspect because the most useful ratio is
 * often not in the list: matching a reference image means whatever that file
 * happens to be, and for image-to-video a frame that does not match the still
 * is the wrong frame -- the model is being handed a first frame it then has to
 * letterbox or stretch.
 */
export function frameForRatio(ratio: number, megapixels: number, multiple = SPATIAL_MULTIPLE): Frame {
  const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const budget = Math.max(0.05, megapixels) * 1_000_000;
  const height = snap(Math.sqrt(budget / safe), multiple, MIN_EDGE);
  const width = snap(height * safe, multiple, MIN_EDGE);
  return { width, height, megapixels: (width * height) / 1_000_000, ratio: width / height };
}

export function resolveFrame(aspect: Aspect, megapixels: number): Frame {
  return frameForRatio(aspectRatio(aspect), megapixels);
}

/**
 * Qwen-Image works in 16-pixel blocks -- an 8x VAE with a 2x patch embed on
 * top -- rather than the video model's 32. Snapping to 32 anyway would quietly
 * refuse sizes the model accepts, 1360 among them, which is the height of a
 * 3:4 frame at one megapixel.
 */
export const IMAGE_MULTIPLE = 16;

export function resolveImageFrame(ratio: number, megapixels: number): Frame {
  return frameForRatio(ratio, megapixels, IMAGE_MULTIPLE);
}

/** The select value standing for "whatever the reference image is". */
export const REFERENCE_ASPECT = 'reference';

export interface Duration {
  numFrames: number;
  /** Runtime of the rounded frame count, which is rarely the request. */
  seconds: number;
}

/** Frame counts are `8n+1` because the VAE compresses time by 8. */
export function resolveDuration(seconds: number, fps: number): Duration {
  const wanted = Math.max(1, seconds) * Math.max(1, fps);
  const steps = Math.max(1, Math.round((wanted - 1) / TEMPORAL_MULTIPLE));
  const numFrames = steps * TEMPORAL_MULTIPLE + 1;
  return { numFrames, seconds: numFrames / Math.max(1, fps) };
}

/**
 * MiniMax-H3's temporal grid: `17k + 5` frames, and only at 24 fps.
 *
 * A different rule from LTX's `8n+1` rather than a different constant in the
 * same one: H3's first latent block holds five frames and every block after it
 * holds seventeen, so 5, 22, 39 ... 124 ... 362 are the lengths that exist and
 * nothing rounds to something between them. The frame rate is not a setting
 * either -- the audio latents are sized from the clip's duration in seconds,
 * and the model was trained at one rate.
 */
export const H3_FRAME_BLOCK = 17;
export const H3_FRAME_OFFSET = 5;
export const H3_FPS = 24;
/** The trained range, 5 s to 15 s, on the grid above. */
export const H3_MIN_FRAMES = 124;
export const H3_MAX_FRAMES = 362;

export function alignH3Frames(frames: number): number {
  const wanted = Math.max(H3_FRAME_OFFSET, Math.round(frames));
  // `%` keeps the sign of the dividend in JavaScript, so the gap to the next
  // valid length has to be folded back into range or this rounds *down*.
  const gap = (((H3_FRAME_OFFSET - (wanted % H3_FRAME_BLOCK)) % H3_FRAME_BLOCK) + H3_FRAME_BLOCK) %
    H3_FRAME_BLOCK;
  return wanted + gap;
}

export function resolveH3Duration(seconds: number): Duration {
  const numFrames = Math.min(H3_MAX_FRAMES, alignH3Frames(Math.max(0, seconds) * H3_FPS));
  return { numFrames, seconds: numFrames / H3_FPS };
}

/**
 * H3's native canvas: a 768-pixel short edge under a `768x1344` area cap.
 *
 * Offered as a button rather than enforced. Above the cap the model is being
 * asked for a resolution it was never trained at -- its 2K output comes from a
 * hosted regeneration pass that is not part of the open release -- and below it
 * the clip is cheap but soft.
 */
export const H3_SHORT_EDGE = 768;
export const H3_MAX_PIXELS = 768 * 1344;

export function h3Canvas(ratio: number): { width: number; height: number } {
  const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  let width = safe >= 1 ? H3_SHORT_EDGE * safe : H3_SHORT_EDGE;
  let height = safe >= 1 ? H3_SHORT_EDGE : H3_SHORT_EDGE / safe;

  const area = width * height;
  if (area > H3_MAX_PIXELS) {
    const scale = Math.sqrt(H3_MAX_PIXELS / area);
    width *= scale;
    height *= scale;
  }

  const snapTo = (value: number): number =>
    Math.max(SPATIAL_MULTIPLE, Math.round(value / SPATIAL_MULTIPLE) * SPATIAL_MULTIPLE);
  return { width: snapTo(width), height: snapTo(height) };
}

/** What the transformer actually attends over, and the best single cost signal. */
export function latentTokens(width: number, height: number, numFrames: number): number {
  const across = Math.floor(width / SPATIAL_MULTIPLE);
  const down = Math.floor(height / SPATIAL_MULTIPLE);
  const deep = Math.floor((numFrames - 1) / TEMPORAL_MULTIPLE) + 1;
  return across * down * deep;
}

export interface Output {
  width: number;
  height: number;
  numFrames: number;
  fps: number;
  seconds: number;
}

/**
 * Each upsampler doubles what stage one produced; neither changes the request.
 *
 * The temporal round adds frames at a fixed duration, so what doubles is the
 * frame rate rather than the runtime. That is what the audio forces: audio
 * latents are sized from the clip's seconds, and a round that stretched the
 * duration would leave them the wrong length.
 */
export function resolveOutput(
  frame: Frame,
  duration: Duration,
  fps: number,
  spatial: boolean,
  temporal: boolean,
): Output {
  const numFrames = temporal ? duration.numFrames * 2 - 1 : duration.numFrames;
  return {
    width: spatial ? frame.width * 2 : frame.width,
    height: spatial ? frame.height * 2 : frame.height,
    numFrames,
    fps: (numFrames / duration.numFrames) * fps,
    seconds: duration.seconds,
  };
}
