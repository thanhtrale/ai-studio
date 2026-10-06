import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import PromptDiff from './PromptDiff.vue';

describe('PromptDiff', () => {
  it('highlights what was added and strikes through what was removed', () => {
    const wrapper = mount(PromptDiff, {
      props: { before: 'trời mưa, a crane lands', after: 'Heavy rain, a crane lands softly' },
    });

    const added = wrapper.findAll('[data-diff="added"]').map((node) => node.text());
    const removed = wrapper.findAll('[data-diff="removed"]');

    expect(added.join(' ')).toContain('Heavy rain,');
    expect(added.join(' ')).toContain('softly');
    expect(removed.map((node) => node.text()).join(' ')).toBe('trời mưa,');
    expect(removed[0]!.classes()).toEqual(expect.arrayContaining(['line-through', 'grayscale']));
    expect(wrapper.text()).toContain('+3 words added');
    expect(wrapper.text()).toContain('−2 words removed');
  });
});
