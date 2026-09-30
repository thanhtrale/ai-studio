import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpSession, McpToolResult } from '../analysis/design/mcp';
import { imageOfResult, imageUrlOfResult } from '../analysis/design/mcp';

import { FigmaMcpShots, FigmaRestShots } from './images';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function ok(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('reading an image out of a tool result', () => {
  it('reads the inline bytes the protocol defines', () => {
    const result: McpToolResult = {
      content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    };
    expect(imageOfResult(result)?.bytes).toEqual(PNG);
  });

  it('reads a resource that carries its bytes as a blob', () => {
    const result = {
      content: [{ type: 'resource', resource: { blob: PNG.toString('base64'), mimeType: 'image/png' } }],
    } as unknown as McpToolResult;
    expect(imageOfResult(result)?.bytes).toEqual(PNG);
  });

  it('finds the link when the server points at the image instead of sending it', () => {
    // The shape current Figma builds actually answer with, and the one that was
    // being read as "no image".
    const link = {
      content: [{ type: 'resource_link', uri: 'http://127.0.0.1:3845/assets/abc123.png' }],
    } as unknown as McpToolResult;
    expect(imageUrlOfResult(link)).toBe('http://127.0.0.1:3845/assets/abc123.png');

    const prose: McpToolResult = {
      content: [{ type: 'text', text: 'Screenshot saved: http://127.0.0.1:3845/assets/abc123.png' }],
    };
    expect(imageUrlOfResult(prose)).toBe('http://127.0.0.1:3845/assets/abc123.png');
  });

  it('says nothing when there is nothing to say', () => {
    const empty: McpToolResult = { content: [{ type: 'text', text: 'no selection' }] };
    expect(imageOfResult(empty)).toBeNull();
    expect(imageUrlOfResult(empty)).toBeNull();
  });
});

describe('FigmaMcpShots', () => {
  function session(result: McpToolResult): McpSession {
    return { async call() { return result; }, async close() {} };
  }

  it('fetches the bytes when the answer was a link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(PNG)));

    const shots = new FigmaMcpShots(
      session({ content: [{ type: 'text', text: 'http://127.0.0.1:3845/assets/a.png' }] }),
    );

    expect((await shots.one('1:2'))?.bytes).toEqual(PNG);
  });

  it('is silent about a node Figma refused', async () => {
    const shots = new FigmaMcpShots(session({ content: [], isError: true }));
    expect(await shots.one('1:2')).toBeNull();
  });
});

describe('FigmaRestShots', () => {
  it('renders a batch and fetches every url it got back', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('https://api.figma.com')) {
          return new Response(
            JSON.stringify({ err: null, images: { '1:2': 'https://cdn/1.png', '3:4': null } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return ok(PNG);
      }),
    );

    const found = await new FigmaRestShots('AbCdEf123456', 'tok').shots(['1:2', '3:4']);

    expect(calls[0]).toContain('ids=1%3A2%2C3%3A4');
    expect(calls[0]).toContain('scale=2');
    expect(found.get('1:2')?.bytes).toEqual(PNG);
    // A node Figma declined to render is absent rather than empty.
    expect(found.has('3:4')).toBe(false);
  });

  it('names the token when the endpoint refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));

    await expect(new FigmaRestShots('AbCdEf123456', 'bad').shots(['1:2'])).rejects.toThrow(
      /personal access token/,
    );
  });
});
