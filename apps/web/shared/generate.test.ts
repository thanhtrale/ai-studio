import { describe, expect, it } from 'vitest';

import { mergePrompt } from './generate';

describe('mergePrompt', () => {
  it('joins the subject and the style into one prompt', () => {
    expect(mergePrompt('a paper crane', '3d render, cinematic light')).toBe(
      'a paper crane, 3d render, cinematic light',
    );
  });

  it('leaves no trace of an empty style', () => {
    // The two boxes are a convenience of the form. Someone who writes the whole
    // prompt in one of them must get exactly what they wrote.
    expect(mergePrompt('a paper crane')).toBe('a paper crane');
    expect(mergePrompt('a paper crane', '   ')).toBe('a paper crane');
  });

  it('works with the style alone', () => {
    expect(mergePrompt('', '3d render')).toBe('3d render');
  });

  it('does not double the separator the user already typed', () => {
    expect(mergePrompt('a paper crane,', '3d render')).toBe('a paper crane, 3d render');
    expect(mergePrompt('a paper crane, ', '3d render')).toBe('a paper crane, 3d render');
  });

  it('keeps punctuation that is not a separator', () => {
    expect(mergePrompt('a paper crane.', '3d render')).toBe('a paper crane., 3d render');
  });
});
