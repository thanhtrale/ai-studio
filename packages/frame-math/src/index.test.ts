import { describe, expect, it } from 'vitest';

import {
  alignH3Frames,
  aspectRatio,
  frameForRatio,
  h3Canvas,
  IMAGE_MULTIPLE,
  latentTokens,
  resolveDuration,
  resolveFrame,
  resolveH3Duration,
  resolveImageFrame,
  resolveOutput,
} from './index';

describe('resolveFrame', () => {
  it('rounds width from the rounded height, not from the raw one', () => {
    // Rounding both independently gives 928x544 and a ratio of 1.71.
    expect(resolveFrame('16:9', 0.5)).toEqual({
      width: 960,
      height: 544,
      megapixels: 0.52224,
      ratio: 960 / 544,
    });
  });

  it('keeps every side a multiple of 32', () => {
    for (const mp of [0.1, 0.25, 0.5, 1, 2]) {
      for (const aspect of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const) {
        const { width, height } = resolveFrame(aspect, mp);
        expect(width % 32).toBe(0);
        expect(height % 32).toBe(0);
      }
    }
  });

  it('never goes below the model floor', () => {
    const { width, height } = resolveFrame('1:1', 0.001);
    expect(width).toBeGreaterThanOrEqual(256);
    expect(height).toBeGreaterThanOrEqual(256);
  });
});

describe('resolveImageFrame', () => {
  it('keeps every side a multiple of 16, which the video grid would refuse', () => {
    for (const mp of [0.25, 0.5, 1, 2]) {
      for (const aspect of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const) {
        const { width, height } = resolveImageFrame(aspectRatio(aspect), mp);
        expect(width % IMAGE_MULTIPLE).toBe(0);
        expect(height % IMAGE_MULTIPLE).toBe(0);
      }
    }
  });

  it('reaches sizes the 32-grid rounds away', () => {
    // 3:4 at 0.75 MP wants 866x1155. The image grid lands on 752x1008; the
    // video grid has to give up another block in each direction.
    expect(resolveImageFrame(3 / 4, 0.75)).toMatchObject({ width: 752, height: 1008 });
    expect(resolveFrame('3:4', 0.75)).toMatchObject({ width: 736, height: 992 });
  });

  it('matches a reference image ratio rather than a named aspect', () => {
    const frame = resolveImageFrame(1200 / 800, 0.5);
    expect(frame.width / frame.height).toBeCloseTo(1.5, 2);
  });

  it('never goes below the floor', () => {
    const { width, height } = resolveImageFrame(1, 0.001);
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(256);
  });
});

describe('resolveDuration', () => {
  it('rounds 5 s at 24 fps to the nearest 8n+1', () => {
    expect(resolveDuration(5, 24)).toEqual({ numFrames: 121, seconds: 121 / 24 });
  });

  it('always lands on 8n+1', () => {
    for (const seconds of [1, 2.5, 5, 7.3, 12]) {
      for (const fps of [8, 24, 25, 30, 60]) {
        expect((resolveDuration(seconds, fps).numFrames - 1) % 8).toBe(0);
      }
    }
  });
});

describe('latentTokens', () => {
  it('matches the transformer’s sequence length at 960x544x121', () => {
    expect(latentTokens(960, 544, 121)).toBe(8160);
  });
});

describe('resolveH3Duration', () => {
  it('rounds 5 s to the 17k+5 frame the model actually accepts', () => {
    expect(resolveH3Duration(5)).toEqual({ numFrames: 124, seconds: 124 / 24 });
  });

  it('always lands on 17k+5', () => {
    for (const seconds of [0, 0.5, 1, 2.5, 5, 7.3, 12, 15]) {
      expect(resolveH3Duration(seconds).numFrames % 17).toBe(5);
    }
  });

  it('rounds up to the next length that exists, not the nearest round number', () => {
    // 100 frames is 4.17 s, and the next length the temporal pack can express
    // is 107 rather than 102 or 124.
    expect(alignH3Frames(100)).toBe(107);
    expect(alignH3Frames(1)).toBe(5);
  });

  it('stops at the longest clip the model was trained for', () => {
    expect(resolveH3Duration(30).numFrames).toBe(362);
  });
});

describe('h3Canvas', () => {
  it('is a 768 short edge under the model’s area cap', () => {
    expect(h3Canvas(16 / 9)).toEqual({ width: 1344, height: 768 });
    expect(h3Canvas(9 / 16)).toEqual({ width: 768, height: 1344 });
    expect(h3Canvas(1)).toEqual({ width: 768, height: 768 });
  });

  it('never exceeds the cap, however wide the shape', () => {
    for (const ratio of [21 / 9, 16 / 9, 4 / 3, 1, 3 / 4, 9 / 16]) {
      const { width, height } = h3Canvas(ratio);
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      expect(width * height).toBeLessThanOrEqual(768 * 1344);
    }
  });
});

describe('resolveOutput', () => {
  const frame = resolveFrame('16:9', 0.5);
  const duration = resolveDuration(5, 24);

  it('leaves the request alone when no upsampler is asked for', () => {
    expect(resolveOutput(frame, duration, 24, false, false)).toEqual({
      width: 960,
      height: 544,
      numFrames: 121,
      fps: 24,
      seconds: duration.seconds,
    });
  });

  it('doubles each edge spatially and the frame rate temporally, at a fixed duration', () => {
    const out = resolveOutput(frame, duration, 24, true, true);
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1088);
    expect(out.numFrames).toBe(241);
    expect(out.seconds).toBeCloseTo(duration.seconds, 6);
    // 241 frames over the same 5.04 s is very nearly twice 24 fps.
    expect(out.fps).toBeCloseTo(47.8, 1);
  });
});

describe('frameForRatio', () => {
  it('honours a ratio that is not in the list at all', () => {
    // 1200x900 reference: 4:3, which the list happens to have.
    expect(frameForRatio(1200 / 900, 0.5)).toEqual(resolveFrame('4:3', 0.5));
  });

  it('holds an awkward ratio as closely as multiples of 32 allow', () => {
    const frame = frameForRatio(1237 / 903, 0.5);

    expect(frame.width % 32).toBe(0);
    expect(frame.height % 32).toBe(0);
    expect(frame.ratio).toBeCloseTo(1237 / 903, 1);
  });

  it('refuses to produce a degenerate frame from a nonsense ratio', () => {
    for (const ratio of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const frame = frameForRatio(ratio, 0.5);
      expect(frame.width).toBeGreaterThanOrEqual(256);
      expect(frame.height).toBeGreaterThanOrEqual(256);
    }
  });
});
