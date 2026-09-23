// @vitest-environment node
//
// Not happy-dom, which the web project uses for the component tests. Its
// `fetch` is a browser's and enforces the same-origin policy, so a request to a
// loopback port on another origin is blocked before it is sent -- which is
// exactly what this file does, and what the server side of this application
// does all day. Node's fetch has no such notion.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openFigmaSession } from './mcp';
import { FigmaMcpSource } from './source';

/**
 * A real MCP server over real HTTP, in this process.
 *
 * The unit tests above inject a session, which proves the adapter's logic and
 * nothing about the wire. This proves the wire: that the SDK's streamable HTTP
 * transport, the handshake and a tool call actually work the way the adapter
 * assumes. It is a stand-in for Figma, not a substitute for it -- the shape of
 * `get_metadata`'s real output is the kind of thing no stand-in establishes.
 */

const METADATA = `<frame id="7:1" name="Card" width="800" height="400" layoutMode="VERTICAL" itemSpacing="16">
  <text id="7:2" name="Title" characters="Hello" />
</frame>`;

let server: Server;
let url: string;

/**
 * A server and a transport per request.
 *
 * That is what stateless mode means: with no session id there is nothing to
 * correlate a second request with, and a transport that has already seen an
 * `initialize` answers the next POST with a 500. Reusing one looks like it
 * works right up until the client sends `notifications/initialized`.
 */
function handle(): McpServer {
  const mcp = new McpServer({ name: 'figma-stand-in', version: '0.0.0' });

  mcp.registerTool('get_metadata', { description: 'sparse outline' }, () => ({
    content: [{ type: 'text', text: METADATA }],
  }));
  mcp.registerTool('get_variable_defs', { description: 'tokens' }, () => ({
    content: [{ type: 'text', text: 'Color/Brand: #1473E6' }],
  }));
  mcp.registerTool('get_design_context', { description: 'code guess' }, () => ({
    content: [{ type: 'text', text: '<div class="card" />' }],
  }));

  return mcp;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body: unknown = raw ? JSON.parse(raw) : undefined;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on('close', () => void transport.close());
        await handle().connect(transport);
        await transport.handleRequest(request, response, body);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the MCP client, over HTTP', () => {
  it('connects and completes a get_metadata call', async () => {
    const session = await openFigmaSession({ url });
    try {
      const result = await session.call('get_metadata', { nodeId: '7:1' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toMatchObject({ type: 'text' });
    } finally {
      await session.close();
    }
  });

  it('drives a whole read through the adapter', async () => {
    const source = new FigmaMcpSource({ url });
    const { design } = await source.read({ fileKey: 'AbCdEf123456', nodeId: '7:1' });

    expect(design.nodeIds).toEqual(['7:1', '7:2']);
    expect(design.digest).toContain('#7:2 TEXT "Title" text:"Hello"');
    expect(design.tokens).toEqual([{ name: 'Color/Brand', value: '#1473E6' }]);
  });

  it('returns a missing tool as a result that is an error, not a thrown one', async () => {
    // MCP answers an unknown tool with `isError` rather than a transport
    // failure, which is why the adapter's optional calls check the flag as well
    // as catching. A server without `get_screenshot` -- the remote one, or an
    // older desktop build -- degrades instead of failing the read.
    const session = await openFigmaSession({ url });
    try {
      const result = await session.call('get_screenshot', { nodeId: '7:1' });
      expect(result.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('degrades a read when the server has no screenshot tool', async () => {
    const source = new FigmaMcpSource({ url });
    const { design, render, degraded } = await source.read(
      { fileKey: 'AbCdEf123456', nodeId: '7:1' },
      { wantRender: true },
    );

    expect(render).toBeUndefined();
    expect(degraded.join(' ')).toContain('get_screenshot');
    expect(design.digest).toContain('#7:1');
  });

  it('reports nothing listening as the desktop app not running', async () => {
    // A port with nothing behind it is the everyday case: Figma closed, or its
    // local server never enabled.
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });

    await expect(openFigmaSession({ url: `http://127.0.0.1:${closed}/mcp` })).rejects.toMatchObject({
      name: 'DesignSourceError',
      reason: 'unreachable',
    });
  });
});
