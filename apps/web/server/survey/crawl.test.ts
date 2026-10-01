import { describe, expect, it } from 'vitest';

import type { McpSession, McpToolResult } from '../analysis/design/mcp';

import { crawlFigma, moduleHintFor } from './crawl';

/**
 * A page as `get_metadata` returns one: a sparse outline of frames.
 *
 * Three screens, one of them drawn twice at two widths, a section grouping two
 * of them, and a sticky note that is not a screen.
 */
const PAGE = `
<canvas id="0:1" name="Product">
  <section id="1:1" name="Browse">
    <frame id="1:2" name="Listing — Desktop" width="1440" height="2400">
      <instance id="1:3" name="Header/Global" componentName="Header/Global" />
      <instance id="1:4" name="Card/Article" componentName="Card/Article" variant="Size=Large" />
      <instance id="1:5" name="Card/Article" componentName="Card/Article" variant="Size=Small" />
    </frame>
    <frame id="1:6" name="Listing — Mobile" width="390" height="3200">
      <instance id="1:7" name="Header/Global" componentName="Header/Global" />
      <instance id="1:8" name="Card/Article" componentName="Card/Article" variant="Size=Small" />
    </frame>
  </section>
  <frame id="2:1" name="Article detail" width="1440" height="3000">
    <component id="2:2" name="Card/Article" />
    <instance id="2:3" name="Footer/Global" componentName="Footer/Global" />
  </frame>
  <frame id="3:1" name="note" width="40" height="40" />
</canvas>
`;

function session(answers: Record<string, McpToolResult>): McpSession {
  return {
    async call(tool) {
      return answers[tool] ?? { content: [], isError: true };
    },
    async close() {},
  };
}

function metadata(xml: string): McpToolResult {
  return { content: [{ type: 'text', text: xml }] };
}

const ROOT = [{ fileKey: 'AbCdEf123456', nodeId: '0:1', fileName: 'Product file' }];

describe('crawlFigma', () => {
  it('groups the drawings of one screen and orders them widest first', async () => {
    const { inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT);

    const listing = inventory.screens.find((screen) => screen.name === 'Listing');
    expect(listing).toBeDefined();
    expect(listing?.views.map((view) => view.viewport)).toEqual(['desktop', 'mobile']);
    expect(listing?.views.map((view) => view.width)).toEqual([1440, 390]);
    expect(listing?.group).toBe('Browse');
    expect(listing?.page).toBe('Product');
  });

  it('leaves out what is too small to be a screen', async () => {
    const { inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT);
    expect(inventory.screens.map((screen) => screen.name)).not.toContain('note');
  });

  it('transcribes component names exactly and counts their instances', async () => {
    const { inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT);

    const card = inventory.components.find((component) => component.name === 'Card/Article');
    expect(card).toBeDefined();
    expect(card?.instances).toBe(3);
    expect(card?.variants).toEqual(['Size=Large', 'Size=Small']);
    // The main component outranks an instance as the node to point a reader at.
    expect(card?.type).toBe('COMPONENT');
    expect(card?.definitionNodeId).toBe('2:2');
    expect(card?.nodeId).toBe('2:2');
    expect(card?.screenIds.length).toBe(2);
  });

  it('points every component and view back at its own node', async () => {
    const { inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT);

    const header = inventory.components.find((component) => component.name === 'Header/Global');
    expect(header?.url).toContain('AbCdEf123456');
    expect(header?.url).toContain('node-id=1-3');
  });

  it('groups by the component path until a model says otherwise', async () => {
    const { inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT);

    const card = inventory.components.find((component) => component.name === 'Card/Article');
    const module = inventory.modules.find((entry) => entry.id === card?.moduleId);
    expect(module?.name).toBe('Card');
    expect(moduleHintFor('Card/Article/Horizontal')).toBe('Card');
  });

  it('keeps the widest drawing of each screen for a later pass to read', async () => {
    const { trees, inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT);

    const listing = inventory.screens.find((screen) => screen.name === 'Listing');
    expect(trees.get(listing?.id ?? '')?.id).toBe('1:2');
  });

  it('says how far it got when the file is larger than the cap', async () => {
    const { inventory } = await crawlFigma(session({ get_metadata: metadata(PAGE) }), ROOT, {
      maxScreens: 1,
      maxComponents: 400,
    });

    expect(inventory.screens).toHaveLength(1);
    expect(inventory.warnings.join(' ')).toContain('stopped at 1 screens');
  });

  it('reports the reason rather than an empty index when Figma refuses', async () => {
    await expect(crawlFigma(session({}), ROOT)).rejects.toThrow(/would not read node 0:1/);
  });

  it('treats a single linked frame as a screen rather than as a page', async () => {
    const frame = `<frame id="9:1" name="Hero" width="1440" height="600">
      <instance id="9:2" name="Button/Primary" componentName="Button/Primary" />
    </frame>`;

    const { inventory } = await crawlFigma(session({ get_metadata: metadata(frame) }), [
      { fileKey: 'AbCdEf123456', nodeId: '9:1' },
    ]);

    expect(inventory.screens.map((screen) => screen.name)).toEqual(['Hero']);
    expect(inventory.components.map((component) => component.name)).toEqual(['Button/Primary']);
  });

  it('counts two renamed instances of one component as one component', async () => {
    // Renaming an instance in place is ordinary; the main component's id is
    // what says the two are the same thing.
    const page = `<canvas id="0:1" name="Product">
      <frame id="1:1" name="Home" width="1440" height="900">
        <instance id="1:2" name="media card" componentId="90:1" />
        <instance id="1:3" name="split media" componentId="90:1" />
      </frame>
    </canvas>`;

    const { inventory } = await crawlFigma(session({ get_metadata: metadata(page) }), ROOT);

    expect(inventory.components).toHaveLength(1);
    expect(inventory.components[0]?.instances).toBe(2);
    expect(inventory.components[0]?.componentId).toBe('90:1');
    // The node a reader is sent to is the main component, not one instance.
    expect(inventory.components[0]?.nodeId).toBe('90:1');
    expect(inventory.screens[0]?.componentIds).toHaveLength(1);
  });
});
