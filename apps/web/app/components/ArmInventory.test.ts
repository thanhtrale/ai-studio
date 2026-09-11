import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { ArmSummary } from '@ai-studio/arm-contract';

import ArmInventory from './ArmInventory.vue';

function arm(overrides: Partial<ArmSummary> = {}): ArmSummary {
  return {
    id: 'text-llamacpp',
    name: 'text-llamacpp',
    modality: 'text',
    protocol: 'openai',
    lifecycle: 'resident',
    capabilities: [],
    gpu: 'exclusive',
    vramEstimateMb: 8000,
    state: 'stopped',
    detail: null,
    startedWith: null,
    paramsSchema: { type: 'object' },
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

const mountInventory = (props: Partial<InstanceType<typeof ArmInventory>['$props']> = {}) =>
  mount(ArmInventory, {
    props: { arms: [arm()], connection: 'connected', ...props },
  });

describe('ArmInventory', () => {
  it('lists each arm with its modality and state', () => {
    const wrapper = mountInventory({
      arms: [arm(), arm({ id: 'image-sdcpp', modality: 'image', lifecycle: 'oneshot', state: 'stopped' })],
    });

    expect(wrapper.get('[data-testid="arm-text-llamacpp"]').text()).toContain('text');
    expect(wrapper.get('[data-testid="state-text-llamacpp"]').text()).toBe('stopped');
    expect(wrapper.get('[data-testid="arm-image-sdcpp"]').text()).toContain('image');
  });

  it('shows a running arm with a usable stop control', () => {
    const wrapper = mountInventory({ arms: [arm({ state: 'running' })] });

    expect(wrapper.get('[data-testid="state-text-llamacpp"]').text()).toBe('running');
    expect(wrapper.get('[data-testid="stop-text-llamacpp"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="start-text-llamacpp"]').attributes('disabled')).toBeDefined();
  });

  it('shows a failed arm with its reason and lets it be retried', () => {
    const wrapper = mountInventory({
      arms: [arm({ state: 'failed', detail: 'arm did not become healthy within 120000ms' })],
    });

    expect(wrapper.get('[data-testid="detail-text-llamacpp"]').text()).toContain('did not become healthy');
    expect(wrapper.get('[data-testid="start-text-llamacpp"]').attributes('disabled')).toBeUndefined();
  });

  it('renders an invalid arm with its error and offers no start control', () => {
    const wrapper = mountInventory({
      arms: [arm({ state: 'invalid', modality: null, lifecycle: null, detail: 'protocol: invalid value' })],
    });

    expect(wrapper.get('[data-testid="detail-text-llamacpp"]').text()).toContain('protocol');
    expect(wrapper.find('[data-testid="start-text-llamacpp"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="stop-text-llamacpp"]').exists()).toBe(false);
  });

  it('reflects a stopped to running transition without remounting', async () => {
    const wrapper = mountInventory();
    expect(wrapper.get('[data-testid="state-text-llamacpp"]').text()).toBe('stopped');

    await wrapper.setProps({ arms: [arm({ state: 'running' })] });

    expect(wrapper.get('[data-testid="state-text-llamacpp"]').text()).toBe('running');
  });

  it('shows a transitional state and disables conflicting controls while busy', () => {
    const wrapper = mountInventory({ busy: { 'text-llamacpp': 'starting' } });

    expect(wrapper.get('[data-testid="state-text-llamacpp"]').text()).toBe('starting');
    expect(wrapper.get('[data-testid="start-text-llamacpp"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="stop-text-llamacpp"]').attributes('disabled')).toBeDefined();
  });

  it('emits start directly when nothing holds the GPU', async () => {
    const wrapper = mountInventory();

    await wrapper.get('[data-testid="start-text-llamacpp"]').trigger('click');

    expect(wrapper.emitted('start')).toEqual([['text-llamacpp']]);
    expect(wrapper.find('[data-testid="eviction-confirm"]').exists()).toBe(false);
  });

  it('names the arm that will be evicted before starting another', async () => {
    const wrapper = mountInventory({
      arms: [arm({ id: 'text-llamacpp', state: 'running' }), arm({ id: 'image-diffusers', modality: 'image' })],
    });

    await wrapper.get('[data-testid="start-image-diffusers"]').trigger('click');

    const confirm = wrapper.get('[data-testid="eviction-confirm"]');
    expect(confirm.text()).toContain('text-llamacpp');
    expect(confirm.text()).toContain('image-diffusers');
    expect(wrapper.emitted('start')).toBeUndefined();

    await wrapper.get('[data-testid="eviction-confirm-button"]').trigger('click');
    expect(wrapper.emitted('start')).toEqual([['image-diffusers']]);
  });

  it('cancels an eviction without starting anything', async () => {
    const wrapper = mountInventory({
      arms: [arm({ id: 'text-llamacpp', state: 'running' }), arm({ id: 'image-diffusers' })],
    });

    await wrapper.get('[data-testid="start-image-diffusers"]').trigger('click');
    await wrapper.get('[data-testid="eviction-cancel-button"]').trigger('click');

    expect(wrapper.emitted('start')).toBeUndefined();
    expect(wrapper.find('[data-testid="eviction-confirm"]').exists()).toBe(false);
  });

  it('emits stop for a running arm', async () => {
    const wrapper = mountInventory({ arms: [arm({ state: 'running' })] });

    await wrapper.get('[data-testid="stop-text-llamacpp"]').trigger('click');

    expect(wrapper.emitted('stop')).toEqual([['text-llamacpp']]);
  });

  it('reports an unreachable supervisor instead of showing arms as stopped', () => {
    const wrapper = mountInventory({ connection: 'unreachable' });

    expect(wrapper.get('[data-testid="supervisor-unavailable"]').text()).toContain('Supervisor unavailable');
    expect(wrapper.text()).not.toContain('stopped');
    expect(wrapper.find('[data-testid="arm-text-llamacpp"]').exists()).toBe(false);
  });

  it('recovers to real state when the supervisor returns', async () => {
    const wrapper = mountInventory({ connection: 'unreachable' });

    await wrapper.setProps({ connection: 'connected', arms: [arm({ state: 'running' })] });

    expect(wrapper.find('[data-testid="supervisor-unavailable"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="state-text-llamacpp"]').text()).toBe('running');
  });
});
