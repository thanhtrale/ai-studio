import { describe, expect, it } from 'vitest';

import {
  JOB_TYPES,
  buildArmPayload,
  coerceJobValues,
  defaultJobValues,
  jobTypeById,
} from './job-types';

/**
 * These assert against each arm's own `parse_job`, read from the Python source.
 * No arm runs on the machine this suite does, so the ceilings and grids are
 * written out here rather than discovered by submitting a job and waiting.
 */
describe('buildArmPayload', () => {
  it('sends every field the arm names, and nothing it does not', () => {
    for (const spec of JOB_TYPES) {
      const payload = buildArmPayload(spec, defaultJobValues(spec), `cloud/x.${spec.outputExtension}`);

      expect(payload['prompt']).toBeTypeOf('string');
      expect(payload['outPath']).toMatch(new RegExp(`\\.${spec.outputExtension}$`));
      // Absent rather than empty: the arm substitutes its own default.
      expect(payload).not.toHaveProperty('negativePrompt');
      expect(payload).not.toHaveProperty('flowShift');
    }
  });

  it('spells references the way each arm expects', () => {
    const h3 = buildArmPayload(jobTypeById('video-h3')!, {}, 'cloud/a.mp4', ['one.png', 'two.png', 'three.png']);
    expect(h3['refImages']).toEqual(['one.png', 'two.png']);

    const ltx = buildArmPayload(jobTypeById('video-ltx')!, {}, 'cloud/a.mp4', ['one.png', 'two.png']);
    expect(ltx['image']).toBe('one.png');
    expect(ltx).not.toHaveProperty('refImages');

    const image = buildArmPayload(jobTypeById('image-qwen-edit')!, {}, 'cloud/a.png', ['a.png', 'b.png', 'c.png', 'd.png']);
    expect(image['refImages']).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('omits the reference key when none was chosen', () => {
    const payload = buildArmPayload(jobTypeById('video-h3')!, {}, 'cloud/a.mp4', []);
    expect(payload).not.toHaveProperty('refImages');
  });
});

describe('coerceJobValues', () => {
  it('clamps out-of-range numbers instead of forwarding a 400', () => {
    const spec = jobTypeById('video-h3')!;
    const values = coerceJobValues(spec, { steps: 999, batch: -5, seed: 1e12 });

    expect(values['steps']).toBe(32);
    expect(values['batch']).toBe(1);
    expect(values['seed']).toBe(2147483647);
  });

  it('snaps sizes onto the grid each arm enforces', () => {
    const video = coerceJobValues(jobTypeById('video-h3')!, { width: 1000, height: 1000 });
    expect(video['width']).toBe(992);
    expect((video['width'] as number) % 32).toBe(0);

    const image = coerceJobValues(jobTypeById('image-qwen-edit')!, { width: 1000 });
    expect(image['width']).toBe(1008);
    expect((image['width'] as number) % 16).toBe(0);

    const ltx = coerceJobValues(jobTypeById('video-ltx')!, { numFrames: 120 });
    expect(((ltx['numFrames'] as number) - 1) % 8).toBe(0);
    expect(ltx['numFrames']).toBe(121);
  });

  it('falls back to the default for an unknown select value', () => {
    const values = coerceJobValues(jobTypeById('video-h3')!, { scheduler: 'nonsense' });
    expect(values['scheduler']).toBe('simple');
  });

  it('keeps H3 inside the frame counts the model was trained on', () => {
    const spec = jobTypeById('video-h3')!;
    expect(coerceJobValues(spec, { numFrames: 1 })['numFrames']).toBe(124);
    expect(coerceJobValues(spec, { numFrames: 10_000 })['numFrames']).toBe(362);
  });

  it('trims and caps a prompt rather than letting the arm refuse it', () => {
    const spec = jobTypeById('video-h3')!;
    const values = coerceJobValues(spec, { prompt: `  ${'a'.repeat(9000)}  ` });
    expect((values['prompt'] as string).length).toBe(8000);
  });
});

describe('job type registry', () => {
  it('declares an arm and a frame spec for every type', () => {
    for (const spec of JOB_TYPES) {
      expect(spec.armId).toMatch(/^[a-z0-9.-]+$/);
      expect(spec.frame.multiple).toBeGreaterThan(0);
      expect(spec.fields.some((field) => field.name === 'prompt')).toBe(true);
      // Width and height are computed from aspect and budget, never typed.
      for (const name of ['width', 'height']) {
        expect(spec.fields.find((field) => field.name === name)?.derived).toBe(true);
      }
    }
  });
});
