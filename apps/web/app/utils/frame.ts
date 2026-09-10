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
 */
export function resolveFrame(aspect: Aspect, megapixels: number): Frame {
  const ratio = aspectRatio(aspect);
  const budget = Math.max(0.05, megapixels) * 1_000_000;
  const height = snap(Math.sqrt(budget / ratio), SPATIAL_MULTIPLE, 256);
  const width = snap(height * ratio, SPATIAL_MULTIPLE, 256);
  return { width, height, megapixels: (width * height) / 1_000_000, ratio: width / height };
}

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
