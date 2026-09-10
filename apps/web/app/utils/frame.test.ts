import { describe, expect, it } from 'vitest';

import { latentTokens, resolveDuration, resolveFrame, resolveOutput } from './frame';

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
