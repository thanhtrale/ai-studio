/**
 * A stand-in for Figma's local MCP server.
 *
 * The real one lives inside the Figma desktop application, which means the
 * analyze console cannot be driven at all unless that application is running,
 * a file is open, and the account has a seat. This serves the same three tools
 * on the same port against a fixed frame, so the console, the digest, the
 * timeline and the failure paths can be worked on without any of that.
 *
 * It is a development aid and nothing more. It does not establish anything
 * about the shape of the real `get_metadata` output -- that is exactly the kind
 * of thing no stand-in establishes, and the adapter reads attributes
 * tolerantly for precisely that reason.
 *
 *   node scripts/figma-stub.mjs [--port 3845]
 *
 * Stop it before opening Figma: they want the same port.
 */

import { createServer } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3845;

/** A two-column editorial card, of the shape the analysis is meant to specify. */
const METADATA = `<frame id="1:1" name="Featured Story Card" x="0" y="0" width="1440" height="760" layoutMode="HORIZONTAL" itemSpacing="80">
  <frame id="1:2" name="Media" width="672" height="760" layoutMode="VERTICAL" itemSpacing="16">
    <rectangle id="1:3" name="Hero image" width="672" height="600" fills="IMAGE" />
    <frame id="1:4" name="Gallery" width="672" height="144" layoutMode="HORIZONTAL" itemSpacing="16">
      <rectangle id="1:5" name="Thumbnail 1" width="144" height="144" fills="IMAGE" />
      <rectangle id="1:6" name="Thumbnail 2" width="144" height="144" fills="IMAGE" />
      <rectangle id="1:7" name="Thumbnail 3" width="144" height="144" fills="IMAGE" />
    </frame>
  </frame>
  <frame id="1:8" name="Copy" width="608" layoutMode="VERTICAL" itemSpacing="24">
    <text id="1:9" name="Eyebrow" width="608" height="20" characters="SENTOSA" />
    <text id="1:10" name="Headline" width="608" height="180" characters="UNVEIL JUNGLE BETWEEN SKY AND SEA" />
    <text id="1:11" name="Body" width="608" height="120" characters="A rainforest retreat above the strait, where the canopy meets the water and every room opens onto both." />
    <frame id="1:12" name="Actions" layoutMode="HORIZONTAL" itemSpacing="24">
      <text id="1:13" name="CTA primary" characters="DISCOVER MORE" />
      <line id="1:14" name="Divider" width="1" height="16" />
      <text id="1:15" name="CTA secondary" characters="LEARN MORE" />
    </frame>
  </frame>
  <vector id="1:16" name="decorative flourish" visible="false" />
</frame>`;

const VARIABLES = [
  'Color/Brand/Primary: #1B4332',
  'Color/Text/Default: #12160F',
  'Space/Gutter: 80',
  'Space/Stack: 24',
  'Type/Display/Size: 72',
].join('\n');

const CONTEXT = `export function FeaturedStoryCard({ eyebrow, headline, body, hero, thumbnails, ctas }) {
  return (
    <section className="grid grid-cols-2 gap-20">
      <div className="flex flex-col gap-4">
        <img className="aspect-[28/25] w-full object-cover" src={hero} />
        <ul className="flex gap-4">{thumbnails.map((t) => <li className="size-36" key={t} />)}</ul>
      </div>
      <div className="flex flex-col gap-6">
        <p className="text-sm uppercase tracking-widest">{eyebrow}</p>
        <h2 className="text-7xl">{headline}</h2>
        <p>{body}</p>
        <div className="flex gap-6">{ctas}</div>
      </div>
    </section>
  );
}`;

/** A 1x1 PNG. The pixels are not the point; the content type is. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function build() {
  const mcp = new McpServer({ name: 'figma-stub', version: '0.0.0' });

  mcp.registerTool('get_metadata', { description: 'Sparse XML outline of a node' }, () => ({
    content: [{ type: 'text', text: METADATA }],
  }));
  mcp.registerTool('get_variable_defs', { description: 'Variables used in the selection' }, () => ({
    content: [{ type: 'text', text: VARIABLES }],
  }));
  mcp.registerTool('get_design_context', { description: 'React + Tailwind guess' }, () => ({
    content: [{ type: 'text', text: CONTEXT }],
  }));
  mcp.registerTool('get_screenshot', { description: 'A rendering of the node' }, () => ({
    content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
  }));

  return mcp;
}

// A server and a transport per request: with no session id there is nothing to
// correlate a second request with, and a transport that has already handled an
// `initialize` answers the next POST with a 500.
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    void (async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on('close', () => void transport.close());
        await build().connect(transport);
        await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
      } catch (error) {
        console.error('[figma-stub]', error);
        if (!response.headersSent) response.writeHead(500).end();
      }
    })();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[figma-stub] serving a fixed frame at http://127.0.0.1:${port}/mcp`);
  console.log('[figma-stub] any node-id in a Figma link resolves to it. Stop this before opening Figma.');
});
