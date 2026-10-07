import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  aspectRatioText,
  parseQwen21Rewrite,
  qwen21RewritePrompt,
  qwen21RewriteRequest,
  type Qwen21RewriteInput,
} from './qwen21';

const armsDir = path.resolve(fileURLToPath(import.meta.url), '../../../../../arms');

const base: Qwen21RewriteInput = {
  prompt: 'a cat on a windowsill',
  comment: '',
  references: 0,
  width: 1344,
  height: 768,
};

describe('qwen21RewriteRequest', () => {
  it('uses the t2i instructions without references and the edit ones with', async () => {
    const t2i = await qwen21RewriteRequest(armsDir, base);
    const edit = await qwen21RewriteRequest(armsDir, { ...base, references: 1 });
    expect(t2i.system).toContain('Image Prompt Rewriting Expert');
    expect(edit.system).toContain('Edit Prompt Enhancer');
  });
});

describe('qwen21RewritePrompt', () => {
  it('tells a text-to-image rewrite the frame, reduced', () => {
    expect(qwen21RewritePrompt(base)).toBe('a cat on a windowsill\nAspect ratio: 7:4');
  });

  it('asks an edit for English, as the arm does', () => {
    expect(qwen21RewritePrompt({ ...base, references: 1 })).toBe(
      'One input image is attached.\na cat on a windowsill\n(Write the description in English.)',
    );
  });

  it('names several references in order', () => {
    expect(qwen21RewritePrompt({ ...base, references: 2 })).toContain('<image1>, <image2>');
  });

  it('folds the note into the draft as a change to make', () => {
    const text = qwen21RewritePrompt({ ...base, comment: 'make it night' });
    expect(text).toContain('a cat on a windowsill');
    expect(text).toContain('make it night');
    expect(text.indexOf('make it night')).toBeGreaterThan(text.indexOf('a cat'));
  });

  it('uses the note alone when there is no draft', () => {
    expect(qwen21RewritePrompt({ ...base, prompt: '', comment: 'a red fox' })).toBe('a red fox\nAspect ratio: 7:4');
  });
});

describe('aspectRatioText', () => {
  it('reduces by the common divisor', () => {
    expect(aspectRatioText(1024, 1024)).toBe('1:1');
    expect(aspectRatioText(832, 1248)).toBe('2:3');
  });
});

describe('parseQwen21Rewrite', () => {
  it('reads rewritten_prompt out of the JSON', () => {
    expect(parseQwen21Rewrite('{"rewritten_prompt": "A cat.", "wh_ratio": "7:4"}')).toBe('A cat.');
  });

  it('reads it out of a fence', () => {
    expect(parseQwen21Rewrite('```json\n{"rewritten_prompt": "A cat."}\n```')).toBe('A cat.');
  });

  it('takes plain text as the prompt itself', () => {
    expect(parseQwen21Rewrite('A cat on a sill.')).toBe('A cat on a sill.');
  });

  it('finds the field when the JSON is wrapped in prose', () => {
    expect(parseQwen21Rewrite('Here: {"rewritten_prompt": "A \\"cat\\".", "wh_ratio": "1:1"} done')).toBe(
      'A "cat".',
    );
  });

  it('folds line breaks into one paragraph', () => {
    expect(parseQwen21Rewrite('{"rewritten_prompt": "A cat.\\n\\nA sill."}')).toBe('A cat. A sill.');
  });

  it('gives up on empty or fieldless answers', () => {
    expect(parseQwen21Rewrite('')).toBeNull();
    expect(parseQwen21Rewrite('{"wh_ratio": "1:1"}')).toBeNull();
    expect(parseQwen21Rewrite('{"rewritten_prompt": "A cat')).toBeNull();
  });
});
