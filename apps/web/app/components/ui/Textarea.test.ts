import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import UiTextarea from './Textarea.vue';

/**
 * Typing Vietnamese means typing through an IME: the browser holds a
 * composition open across several keystrokes and only commits the word when it
 * ends. Nothing in this app may write to the box while that is happening --
 * every 1.5s arm poll re-renders the console around it, and a re-render that
 * pushes the model's value back into the element would throw away a half-typed
 * word.
 */
describe('UiTextarea under an IME', () => {
  it('keeps a composition that a re-render lands in the middle of', async () => {
    const wrapper = mount(UiTextarea, {
      props: { modelValue: '', rows: 4, placeholder: 'first' },
    });
    const textarea = wrapper.get('textarea');

    // The IME opens a composition and puts its intermediate text in the box.
    await textarea.trigger('compositionstart');
    textarea.element.value = 'một con mèo';
    await textarea.trigger('input');

    // The poll lands: the parent re-renders with the model still empty.
    await wrapper.setProps({ placeholder: 'second' });

    expect(textarea.element.value).toBe('một con mèo');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();

    // Committing the word is what reaches the model.
    await textarea.trigger('compositionend');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['một con mèo']);
  });

  it('commits plain typing immediately, with no composition involved', async () => {
    const wrapper = mount(UiTextarea, { props: { modelValue: '' } });
    const textarea = wrapper.get('textarea');

    textarea.element.value = 'an orange cat';
    await textarea.trigger('input');

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['an orange cat']);
  });

  it('shows a value the parent changes while nothing is being composed', async () => {
    const wrapper = mount(UiTextarea, { props: { modelValue: 'old' } });

    await wrapper.setProps({ modelValue: 'restored from a previous run' });

    expect(wrapper.get('textarea').element.value).toBe('restored from a previous run');
  });
});
