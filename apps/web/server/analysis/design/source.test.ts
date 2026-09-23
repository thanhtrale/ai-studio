import { describe, expect, it } from 'vitest';

import { DesignSourceError } from './errors';
import { parseFigmaMetadata, parseVariableDefs } from './figma-metadata';
import type { DesignReference } from './link';
import { classifyMcpError } from './mcp';
import type { McpSession, McpToolResult } from './mcp';
import { FigmaMcpSource } from './source';

const REFERENCE: DesignReference = { fileKey: 'AbCdEf123456', nodeId: '1:1' };

/** What Figma's `get_metadata` returns: a sparse outline, ids and boxes only. */
const METADATA = `
<frame id="1:1" name="Featured Story Card" x="0" y="0" width="1440" height="720" layoutMode="HORIZONTAL" itemSpacing="64">
  <rectangle id="1:2" name="Hero" width="704" height="720" fills="IMAGE" />
  <frame id="1:3" name="Copy" layoutMode="VERTICAL" itemSpacing="24">
    <text id="1:4" name="Eyebrow" characters="SENTOSA" />
    <text id="1:5" name="Headline" characters="UNVEIL JUNGLE BETWEEN SKY AND SEA" width="640" height="72" />
    <vector id="1:6" name="divider" />
  </frame>
</frame>
`;

interface StubOptions {
  metadata?: McpToolResult;
  variables?: McpToolResult;
  context?: McpToolResult;
  screenshot?: McpToolResult;
  throwOn?: Record<string, Error>;
}

function text(value: string): McpToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function stub(options: StubOptions = {}): { session: McpSession; calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, McpToolResult | undefined> = {
    get_metadata: options.metadata ?? text(METADATA),
    get_variable_defs: options.variables ?? text('Color/Brand/Primary: #1473E6\nSpace/Gutter: 64'),
    get_design_context: options.context ?? text('export function Card() { return <div/> }'),
    get_screenshot: options.screenshot,
  };

  return {
    calls,
    session: {
      async call(tool) {
        calls.push(tool);
        const thrown = options.throwOn?.[tool];
        if (thrown) throw thrown;
        return answers[tool] ?? { content: [], isError: true };
      },
      async close() {},
    },
  };
}

function source(options: StubOptions = {}): { source: FigmaMcpSource; calls: string[] } {
  const { session, calls } = stub(options);
  return { source: new FigmaMcpSource({ openSession: async () => session }), calls };
}

describe('FigmaMcpSource', () => {
  it('reads the structure, the tokens and the interpretation', async () => {
    const { source: figma, calls } = source();
    const { design } = await figma.read(REFERENCE);

    expect(calls).toContain('get_metadata');
    expect(design.adapter).toBe('figma-mcp');
    expect(design.nodeId).toBe('1:1');
    expect(design.name).toBe('Featured Story Card');
    expect(design.digest).toContain('#1:5 TEXT "Headline" 640x72');
    expect(design.digest).toContain('HORIZONTAL/gap:64');
    expect(design.digest).toContain('image-fill');
    expect(design.tokens).toEqual([
      { name: 'Color/Brand/Primary', value: '#1473E6' },
      { name: 'Space/Gutter', value: '64' },
    ]);
    expect(design.interpretation).toContain('export function Card');
  });

  it('keeps the node ids the digest mentions, for evidence checking', async () => {
    const { source: figma } = source();
    const { design } = await figma.read(REFERENCE);

    expect(design.nodeIds).toEqual(['1:1', '1:2', '1:3', '1:4', '1:5']);
    // The decorative vector was dropped, and the count says so.
    expect(design.droppedNodes).toBe(1);
  });

  it('does not ask for a rendering when the arm cannot read one', async () => {
    const { source: figma, calls } = source({ screenshot: text('ignored') });
    const { render } = await figma.read(REFERENCE);

    expect(calls).not.toContain('get_screenshot');
    expect(render).toBeUndefined();
  });

  it('takes a rendering when one was asked for', async () => {
    const png = Buffer.from('fake png bytes');
    const { source: figma } = source({
      screenshot: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] },
    });

    const { render } = await figma.read(REFERENCE, { wantRender: true });
    expect(render?.mimeType).toBe('image/png');
    expect(render?.bytes.toString()).toBe('fake png bytes');
  });

  it('degrades rather than failing when an optional call is refused', async () => {
    // A design with a digest and no tokens is worth analysing. Throwing away
    // the expensive call because a cheap one was refused would be the wrong
    // trade.
    const { source: figma } = source({
      variables: { content: [], isError: true },
      throwOn: { get_design_context: new Error('not supported on this server') },
    });

    const { design, degraded } = await figma.read(REFERENCE);
    expect(design.digest).toContain('#1:1');
    expect(design.tokens).toEqual([]);
    expect(design.interpretation).toBeUndefined();
    expect(degraded).toHaveLength(2);
    expect(degraded.join(' ')).toContain('get_design_context');
  });

  it('fails the read when the structure itself cannot be had', async () => {
    const { source: figma } = source({ metadata: { content: [], isError: true } });

    await expect(figma.read(REFERENCE)).rejects.toMatchObject({
      name: 'DesignSourceError',
      reason: 'node-unreadable',
      where: 'get_metadata',
    });
  });

  it('reports an empty outline as the node being unreadable, not as an empty design', async () => {
    const { source: figma } = source({ metadata: text('<metadata></metadata>') });

    await expect(figma.read(REFERENCE)).rejects.toThrow(/no layers/);
  });

  it('closes the session even when the read fails', async () => {
    let closed = false;
    const { session } = stub({ metadata: { content: [], isError: true } });
    const figma = new FigmaMcpSource({
      openSession: async () => ({
        call: session.call.bind(session),
        close: async () => {
          closed = true;
        },
      }),
    });

    await expect(figma.read(REFERENCE)).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

describe('classifyMcpError', () => {
  it('tells a closed desktop app from everything else', () => {
    const refused = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3845'), { code: 'ECONNREFUSED' }),
    });

    const error = classifyMcpError(refused, 'connecting', 'http://127.0.0.1:3845/mcp');
    expect(error.reason).toBe('unreachable');
    expect(error.message).toMatch(/not running, or its local/);
    expect(error.message).toContain('127.0.0.1:3845');
  });

  it('tells a hung call from a refused one', () => {
    expect(classifyMcpError(new Error('Request timed out'), 'get_metadata', 'x').reason).toBe('timeout');
    expect(classifyMcpError(new Error('AbortError'), 'get_metadata', 'x').reason).toBe('timeout');
  });

  it('falls back to a protocol failure, naming the call', () => {
    const error = classifyMcpError(new Error('unknown tool'), 'get_screenshot', 'x');
    expect(error.reason).toBe('protocol');
    expect(error.where).toBe('get_screenshot');
    expect(error.message).toContain('get_screenshot');
  });

  it('passes an already-classified failure through unchanged', () => {
    const original = new DesignSourceError('node-unreadable', 'get_metadata', 'nope');
    expect(classifyMcpError(original, 'other', 'x')).toBe(original);
  });
});

describe('parseFigmaMetadata', () => {
  it('reads ids, names, boxes and layout from the outline', () => {
    const tree = parseFigmaMetadata(METADATA);
    expect(tree?.id).toBe('1:1');
    expect(tree?.type).toBe('FRAME');
    expect(tree?.layout).toBe('HORIZONTAL');
    expect(tree?.spacing).toBe(64);
    expect(tree?.children?.[0]?.hasImageFill).toBe(true);
  });

  it('accepts either spelling of an attribute', () => {
    // The tool's output is not pinned by any contract this project controls,
    // so a reader that insists on one spelling breaks on an upgrade with no
    // symptom but an empty digest.
    const tree = parseFigmaMetadata(
      '<node nodeId="2:1" label="Card" nodeType="FRAME" w="100" h="50" gap="8" direction="VERTICAL" />',
    );
    expect(tree).toMatchObject({ id: '2:1', name: 'Card', type: 'FRAME', width: 100, height: 50 });
    expect(tree?.spacing).toBe(8);
    expect(tree?.layout).toBe('VERTICAL');
  });

  it('keeps what is inside a wrapper it does not recognise', () => {
    const tree = parseFigmaMetadata('<result><nodes><frame id="3:1" name="A"/></nodes></result>');
    expect(tree?.id).toBe('3:1');
  });

  it('groups several roots without inventing an id', () => {
    const tree = parseFigmaMetadata('<frame id="4:1" name="A"/><frame id="4:2" name="B"/>');
    expect(tree?.children?.map((child) => child.id)).toEqual(['4:1', '4:2']);
    // The synthetic parent borrows a real id rather than making one up, so
    // evidence checking can never resolve against something that is not there.
    expect(tree?.id).toBe('4:1');
  });

  it('takes only a node’s own text, not its descendants’', () => {
    const tree = parseFigmaMetadata('<frame id="5:1" name="A"><text id="5:2">inner</text></frame>');
    expect(tree?.text).toBeUndefined();
    expect(tree?.children?.[0]?.text).toBe('inner');
  });

  it('returns null when nothing carried an id', () => {
    expect(parseFigmaMetadata('<metadata></metadata>')).toBeNull();
    expect(parseFigmaMetadata('')).toBeNull();
  });
});

describe('parseVariableDefs', () => {
  it('reads the JSON form', () => {
    expect(parseVariableDefs('{"Color/Brand": "#1473E6", "Space/S": 8}')).toEqual([
      { name: 'Color/Brand', value: '#1473E6' },
      { name: 'Space/S', value: '8' },
    ]);
  });

  it('reads the line form, bulleted or not', () => {
    expect(parseVariableDefs('- Color/Brand: #1473E6\nSpace/S = 8')).toEqual([
      { name: 'Color/Brand', value: '#1473E6' },
      { name: 'Space/S', value: '8' },
    ]);
  });

  it('returns nothing for an empty response', () => {
    expect(parseVariableDefs('   ')).toEqual([]);
  });
});
