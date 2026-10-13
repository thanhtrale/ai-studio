import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RigDraftInfo } from '#shared/generate';

import RigEditor from './RigEditor.vue';

/**
 * The editor's own logic, with the 3D view replaced by a recorder: the view
 * needs WebGL, and what is worth checking here is what the panels, the keys
 * and the buttons do to the rig -- and what is sent when it is approved.
 */

const info: RigDraftInfo = {
  version: 1,
  vertexCount: 2,
  faceCount: 0,
  influences: 4,
  removeFingers: true,
  bones: [
    { name: 'mixamorig:Hips', parent: -1, head: [0, 0, 0], tail: [0, 0.2, 0] },
    { name: 'mixamorig:LeftArm', parent: 0, head: [0.2, 0.5, 0], tail: [0.5, 0.5, 0] },
    { name: 'mixamorig:RightArm', parent: 0, head: [-0.2, 0.5, 0], tail: [-0.5, 0.5, 0] },
  ],
};

const viewport = {
  load: vi.fn(async () => {}),
  setBones: vi.fn(),
  set: vi.fn(),
  weightsChanged: vi.fn(),
  frame: vi.fn(),
  view: vi.fn(),
  pose: vi.fn(),
  positions: vi.fn(() => new Float32Array([0, -1, 0, 0, 1, 0])),
  paintContext: vi.fn(() => null),
  dispose: vi.fn(),
};

vi.mock('../../utils/rig/viewport', () => ({ createRigViewport: vi.fn(async () => viewport) }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('rig.json')) return info;
    if (url.endsWith('weights.bin')) {
      const bytes = new Uint8Array(2 * 4 * 5);
      new Float32Array(bytes.buffer, 0, 8).set([1, 0, 0, 0, 1, 0, 0, 0]);
      return bytes.buffer;
    }
    return {};
  });
  (globalThis as Record<string, unknown>)['$fetch'] = fetchMock;
  (globalThis as Record<string, unknown>)['describeFetchError'] = (error: unknown) => String(error);
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function open() {
  const wrapper = mount(RigEditor, {
    props: { draftId: 'draft-12345678', meshName: 'hero.glb' },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

function press(key: string, extra: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
}

describe('RigEditor', () => {
  it('loads the draft into the view and lists its bones', async () => {
    const wrapper = await open();
    expect(viewport.load).toHaveBeenCalledWith(
      '/api/rig/drafts/draft-12345678/mesh.glb',
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ values: expect.any(Float32Array) }),
    );
    expect(wrapper.find('[data-testid="bone-LeftArm"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('2 vertices · 3 bones');
  });

  it('switches mode and tool from the keyboard, as 3D tools do', async () => {
    await open();
    press('2');
    await flushPromises();
    expect(viewport.set).toHaveBeenCalledWith({ mode: 'weights' });
    press('3');
    await flushPromises();
    expect(viewport.set).toHaveBeenCalledWith({ mode: 'pose' });
    press('1');
    press('r');
    await flushPromises();
    expect(viewport.set).toHaveBeenCalledWith({ tool: 'rotate' });
    press('x');
    await flushPromises();
    expect(viewport.set).toHaveBeenCalledWith({ mirror: false });
  });

  it('edits a joint from the properties panel, mirrored, and undoes it', async () => {
    const wrapper = await open();
    await wrapper.find('[data-testid="bone-LeftArm"]').trigger('click');
    const fields = wrapper.find('[data-testid="bone-properties"]').findAll('input');
    // Head Y of LeftArm.
    await fields[1]!.setValue('0.55');
    await fields[1]!.trigger('blur');
    expect(wrapper.text()).toContain('2 bones moved');
    const last = viewport.setBones.mock.calls.at(-1)![0] as { head: number[] }[];
    expect(last[1]!.head).toEqual([0.2, 0.55, 0]);
    expect(last[2]!.head).toEqual([-0.2, 0.55, 0]);

    press('z', { ctrlKey: true });
    await flushPromises();
    expect(wrapper.text()).not.toContain('bones moved');
    press('z', { ctrlKey: true, shiftKey: true });
    await flushPromises();
    expect(wrapper.text()).toContain('2 bones moved');
  });

  it('approves with only the bones that moved, and no weights upload when none were painted', async () => {
    const wrapper = await open();
    await wrapper.find('[data-testid="bone-LeftArm"]').trigger('click');
    const fields = wrapper.find('[data-testid="bone-properties"]').findAll('input');
    await fields[0]!.setValue('0.25');
    await fields[0]!.trigger('blur');
    await wrapper.find('[data-testid="approve"]').trigger('click');
    await flushPromises();

    const [[edits]] = wrapper.emitted('approve') as [[Record<string, unknown>]];
    expect(Object.keys(edits).sort()).toEqual(['mixamorig:LeftArm', 'mixamorig:RightArm']);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/weights'))).toBe(false);
  });

  it('asks before throwing edits away', async () => {
    const wrapper = await open();
    await wrapper.find('[data-testid="discard"]').trigger('click');
    // Nothing edited: straight out.
    expect(wrapper.emitted('discard')).toHaveLength(1);

    const edited = await open();
    await edited.find('[data-testid="bone-LeftArm"]').trigger('click');
    const fields = edited.find('[data-testid="bone-properties"]').findAll('input');
    await fields[2]!.setValue('0.1');
    await fields[2]!.trigger('blur');
    await edited.find('[data-testid="discard"]').trigger('click');
    expect(edited.emitted('discard')).toBeUndefined();
    await edited.find('[data-testid="confirm-discard"]').trigger('click');
    expect(edited.emitted('discard')).toHaveLength(1);
  });
});
