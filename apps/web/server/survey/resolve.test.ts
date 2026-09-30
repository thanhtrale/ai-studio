import { describe, expect, it } from 'vitest';

import type { SurveyComponent, SurveyInventory } from '#shared/survey';

import type { McpSession, McpToolResult } from '../analysis/design/mcp';

import { resolveMainComponents } from './resolve';

function component(over: Partial<SurveyComponent> & { id: string }): SurveyComponent {
  return {
    name: 'instance name',
    type: 'INSTANCE',
    variants: [],
    instances: 1,
    nodeId: '1:2',
    url: 'https://figma.com',
    screenIds: [],
    ...over,
  };
}

function inventory(components: SurveyComponent[]): SurveyInventory {
  return {
    fileKey: 'AbCdEf123456',
    pages: [],
    modules: [],
    components,
    screens: [
      {
        id: 'home',
        name: 'Home',
        page: 'Product',
        views: [],
        componentIds: components.map((entry) => entry.id),
        sections: [],
        nodeCount: 0,
      },
    ],
    warnings: [],
  };
}

function session(answers: Record<string, string>): McpSession {
  return {
    async call(_tool, args) {
      const nodeId = String((args as { nodeId?: string }).nodeId ?? '');
      const xml = answers[nodeId];
      return (xml === undefined
        ? { content: [], isError: true }
        : { content: [{ type: 'text', text: xml }] }) as McpToolResult;
    },
    async close() {},
  };
}

describe('resolveMainComponents', () => {
  it('takes the name from the main component, not from the instance', async () => {
    const components = [
      component({ id: 'media-card', name: 'media card', componentId: '90:1' }),
    ];
    const store = inventory(components);

    const resolved = await resolveMainComponents(
      session({ '90:1': '<component id="90:1" name="Content-card/split/media" width="640" height="360" />' }),
      store,
      { fileKey: 'AbCdEf123456' },
    );

    expect(resolved).toBe(1);
    expect(components[0]?.name).toBe('Content-card/split/media');
    expect(components[0]?.type).toBe('COMPONENT');
    expect(components[0]?.resolved).toBe(true);
    expect(components[0]?.nodeId).toBe('90:1');
    expect(components[0]?.url).toContain('node-id=90-1');
    expect(components[0]?.width).toBe(640);
  });

  it('folds two renamed instances of one component into one entry', async () => {
    const components = [
      component({ id: 'media-card', name: 'media card', componentId: '90:1', instances: 3, screenIds: ['home'] }),
      component({ id: 'split-media', name: 'split media', componentId: '90:1', instances: 2, screenIds: ['home'] }),
    ];
    const store = inventory(components);

    await resolveMainComponents(
      session({ '90:1': '<component id="90:1" name="Content-card/split/media" />' }),
      store,
      { fileKey: 'AbCdEf123456' },
    );

    expect(store.components).toHaveLength(1);
    expect(store.components[0]?.instances).toBe(5);
    // The screen pointed at the entry that no longer exists.
    expect(store.screens[0]?.componentIds).toEqual(['media-card']);
  });

  it('leaves the instance reading in place when the library will not open', async () => {
    const components = [component({ id: 'media-card', name: 'media card', componentId: '90:1' })];
    const store = inventory(components);
    const warnings: string[] = [];

    const resolved = await resolveMainComponents(session({}), store, {
      fileKey: 'AbCdEf123456',
      onWarning: (warning) => warnings.push(warning),
    });

    expect(resolved).toBe(0);
    expect(components[0]?.name).toBe('media card');
    expect(components[0]?.resolved).toBeUndefined();
    expect(warnings.join(' ')).toContain('would not read');
  });

  it('reads what is inside the component, not only its name', async () => {
    const components = [component({ id: 'media-card', componentId: '90:1' })];
    const store = inventory(components);

    await resolveMainComponents(
      session({
        '90:1': `<component id="90:1" name="Content-card/split/media" width="640" height="360">
          <rectangle id="90:2" name="Image" width="320" height="360" fills="IMAGE" />
          <frame id="90:3" name="Copy">
            <text id="90:4" name="Kicker" characters="WELLNESS" />
            <text id="90:5" name="Headline" characters="Wellness with new eyes" />
            <instance id="90:6" name="Button/Text" componentName="Button/Text" />
          </frame>
        </component>`,
      }),
      store,
      { fileKey: 'AbCdEf123456' },
    );

    const resolved = components[0];
    expect(resolved?.structure).toContain('Headline');
    expect(resolved?.text).toEqual(['WELLNESS', 'Wellness with new eyes']);
    expect(resolved?.uses).toEqual(['Button/Text']);
    expect(resolved?.nodeCount).toBe(6);
  });

  it('takes every variant a set declares, not only the ones somebody placed', async () => {
    const components = [
      component({ id: 'button', componentId: '7:1', variants: ['Size=Large'] }),
    ];
    const store = inventory(components);

    await resolveMainComponents(
      session({
        '7:1': `<component_set id="7:1" name="Button">
          <component id="7:2" name="Size=Large" />
          <component id="7:3" name="Size=Small" />
          <component id="7:4" name="Size=Small, State=Hover" />
        </component_set>`,
      }),
      store,
      { fileKey: 'AbCdEf123456' },
    );

    expect(components[0]?.type).toBe('COMPONENT_SET');
    expect(components[0]?.variants).toEqual(['Size=Large', 'Size=Small', 'Size=Small, State=Hover']);
  });

  it('still reads a component whose definition the crawl already found', async () => {
    // The crawl knew where it was; it never looked inside it.
    const components = [
      component({ id: 'button', name: 'Button', componentId: '5:5', definitionNodeId: '5:5' }),
    ];
    const store = inventory(components);

    const read = await resolveMainComponents(
      session({ '5:5': '<component id="5:5" name="Button"><text id="5:6" characters="Book now" /></component>' }),
      store,
      { fileKey: 'AbCdEf123456' },
    );

    expect(read).toBe(1);
    expect(components[0]?.text).toEqual(['Book now']);
  });

  it('skips a component it has already read', async () => {
    const components = [component({ id: 'button', componentId: '5:5', structure: 'already read' })];
    const store = inventory(components);

    // Nothing answers; the call must never be made in the first place.
    expect(await resolveMainComponents(session({}), store, { fileKey: 'AbCdEf123456' })).toBe(0);
    expect(components[0]?.structure).toBe('already read');
  });
});
