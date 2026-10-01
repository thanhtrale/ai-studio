import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';

import type { ArmSummary } from '@ai-studio/arm-contract';

import ImageConsole from './ImageConsole.vue';

/**
 * The console has to drive two image arms that disagree about what a job is.
 *
 * One samples on a guided KSampler in sixteen-pixel blocks; the other is a
 * distilled student on a fixed sigma schedule, unguided, in blocks of
 * thirty-two, with a prompt rewriter. Offering the first one's controls for
 * the second is how someone sets a CFG scale that is silently thrown away.
 */
function arm(overrides: Partial<ArmSummary> = {}): ArmSummary {
  return {
    id: 'image-qwen-edit-comfy',
    name: 'Qwen-Image-Edit 2511 (ComfyUI)',
    modality: 'image',
    protocol: 'native',
    lifecycle: 'resident',
    capabilities: ['image.generate'],
    gpu: 'exclusive',
    vramEstimateMb: 15300,
    state: 'stopped',
    detail: null,
    startedWith: null,
    paramsSchema: {
      type: 'object',
      properties: { diffusionModel: { default: 'models/qwen/edit.safetensors' } },
    },
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

const turboArm = arm({
  id: 'image-qwen21-turbo-comfy',
  name: 'Qwen-Image 2.1 + viggle-turbo (ComfyUI)',
  paramsSchema: {
    type: 'object',
    properties: {
      diffusionModel: { default: 'models/qwen-image-2.1/diffusion_models/qwen_image_2.1_bf16.safetensors' },
      // The one fact the console reads to know this arm samples on a distilled
      // schedule: it declares a turbo LoRA.
      turboLora: { default: 'models/qwen-image-2.1/loras/viggle-turbo.safetensors' },
    },
  },
});

beforeEach(() => {
  const globals = globalThis as Record<string, unknown>;
  globals['useMedia'] = () => ({
    byId: computed(() => new Map()),
    groups: computed(() => []),
    pending: computed(() => false),
    refresh: async () => {},
    upload: async () => null,
  });
  globals['useJobTelemetry'] = () => ({
    job: ref(null),
    machine: ref([]),
    armVram: ref([]),
    capacityGib: ref(16),
    available: ref(true),
    elapsedSeconds: ref(0),
    watch: () => {},
    stopWatching: () => {},
  });
  globals['$fetch'] = async () => ({ media: [], report: null });
  globals['describeFetchError'] = (error: unknown) => String(error);
});

const mountConsole = (arms: ArmSummary[]) =>
  mount(ImageConsole, {
    props: { arms },
    global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } },
  });

describe('ImageConsole arm selection', () => {
  it('offers every arm that declares the image contract', () => {
    const options = mountConsole([arm(), turboArm]).get('#arm').findAll('option');

    expect(options.map((option) => option.attributes('value'))).toEqual([
      'image-qwen-edit-comfy',
      'image-qwen21-turbo-comfy',
    ]);
  });

  it('leaves out an arm that cannot serve an image job', () => {
    const wrapper = mountConsole([arm(), arm({ id: 'text-llamacpp', capabilities: [] })]);

    expect(wrapper.get('#arm').findAll('option')).toHaveLength(1);
  });

  it('offers guidance and a scheduler for a guided arm', () => {
    const wrapper = mountConsole([arm()]);

    expect(wrapper.find('#cfg').exists()).toBe(true);
    expect(wrapper.find('#sampler').exists()).toBe(true);
    expect(wrapper.find('#scheduler').exists()).toBe(true);
    expect(wrapper.find('#flow').exists()).toBe(true);
    // No rewriter on this arm, so no control claiming there is one.
    expect(wrapper.text()).not.toContain('Rewrite the prompt first');
  });

  it('hides the controls a turbo arm has nowhere to put', async () => {
    const wrapper = mountConsole([turboArm]);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('#cfg').exists()).toBe(false);
    expect(wrapper.find('#sampler').exists()).toBe(false);
    expect(wrapper.find('#scheduler').exists()).toBe(false);
    expect(wrapper.find('#flow').exists()).toBe(false);
    // The seed has to survive the fields around it disappearing.
    expect(wrapper.find('#seed-turbo').exists()).toBe(true);
    expect(wrapper.text()).toContain('Rewrite the prompt first');
  });

  it('snaps the frame onto the selected arm\u2019s own grid', async () => {
    const wrapper = mountConsole([arm(), turboArm]);

    expect(wrapper.get('#width').attributes('step')).toBe('16');
    expect(wrapper.text()).toContain('a multiple of 16');

    await wrapper.get('#arm').setValue('image-qwen21-turbo-comfy');

    expect(wrapper.get('#width').attributes('step')).toBe('32');
    expect(wrapper.text()).toContain('a multiple of 32');
  });

  it('brings the new arm\u2019s sampling settings with it', async () => {
    const wrapper = mountConsole([arm(), turboArm]);

    expect((wrapper.get('#steps').element as HTMLInputElement).value).toBe('4');

    await wrapper.get('#arm').setValue('image-qwen21-turbo-comfy');

    // Six steps is the schedule the turbo LoRA was distilled for; carrying the
    // edit arm's four across would be a schedule it was not trained on.
    expect((wrapper.get('#steps').element as HTMLInputElement).value).toBe('6');
  });

  it('names the model the selected arm loads', async () => {
    const wrapper = mountConsole([arm(), turboArm]);

    expect(wrapper.text()).toContain('edit.safetensors');

    await wrapper.get('#arm').setValue('image-qwen21-turbo-comfy');

    expect(wrapper.text()).toContain('qwen_image_2.1_bf16.safetensors');
  });
});
