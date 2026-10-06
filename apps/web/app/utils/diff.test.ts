import { describe, expect, it } from 'vitest';

import { diffStats, diffWords, tokenize } from './diff';

const newSide = (parts: ReturnType<typeof diffWords>) =>
  parts.filter((part) => part.kind !== 'removed').map((part) => part.text).join('');
const oldWords = (parts: ReturnType<typeof diffWords>) =>
  parts
    .filter((part) => part.kind !== 'added')
    .flatMap((part) => part.text.split(/\s+/))
    .filter(Boolean)
    .join(' ');

describe('tokenize', () => {
  it('keeps every character, line breaks included', () => {
    const text = '  Look.\n\nTimeline:\n[0s-2s] a  b';
    expect(tokenize(text).join('')).toBe(text);
    expect(tokenize('')).toEqual([]);
  });
});

describe('diffWords', () => {
  it('marks what was added and what was taken out', () => {
    const parts = diffWords('a crane lands on a rock', 'a white crane lands softly on a rock');

    expect(parts).toEqual([
      { kind: 'same', text: 'a ' },
      { kind: 'added', text: 'white ' },
      { kind: 'same', text: 'crane lands ' },
      { kind: 'added', text: 'softly ' },
      { kind: 'same', text: 'on a rock' },
    ]);
    expect(diffStats(parts)).toEqual({ added: 2, removed: 0 });
  });

  it('groups a replaced run into one removal and one addition', () => {
    const parts = diffWords('the sky is grey today', 'the sky is golden at dawn');

    expect(parts.map((part) => part.kind)).toEqual(['same', 'removed', 'added']);
    expect(diffStats(parts)).toEqual({ added: 3, removed: 2 });
  });

  it('rebuilds the new text exactly, and the old words in order', () => {
    const before = 'cho trời mưa\nthêm tiếng sấm';
    const after = 'Heavy rain falls.\n\nTimeline:\n[0s-5s] rain, distant thunder';
    const parts = diffWords(before, after);

    expect(newSide(parts)).toBe(after);
    expect(oldWords(parts)).toBe('cho trời mưa thêm tiếng sấm');
  });

  it('treats a word as unchanged when only the space after it moved', () => {
    const parts = diffWords('one two', 'one\n\ntwo');
    expect(parts).toEqual([{ kind: 'same', text: 'one\n\ntwo' }]);
  });

  it('handles an empty side', () => {
    expect(diffWords('', 'new text')).toEqual([{ kind: 'added', text: 'new text' }]);
    expect(diffWords('old text', '')).toEqual([{ kind: 'removed', text: 'old text' }]);
    expect(diffWords('', '')).toEqual([]);
  });
});
