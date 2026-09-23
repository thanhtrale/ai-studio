/**
 * Talking to Figma's local MCP server.
 *
 * The server runs inside the Figma desktop application, at
 * `http://127.0.0.1:3845/mcp`, and is enabled from that app's preferences. It
 * is reached from the web application's server side like everything else here:
 * the browser never opens a connection of its own.
 *
 * The session is deliberately narrow -- one `call`, one `close` -- so that the
 * adapter above it is testable without the SDK, and so that swapping the
 * transport (Figma also publishes a remote server) touches one function.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { DesignSourceError } from './errors';

/** Where the Figma desktop app puts its MCP server. */
export const FIGMA_MCP_URL = 'http://127.0.0.1:3845/mcp';

/**
 * Per-call budget.
 *
 * Generous, because `get_design_context` on a large frame is genuinely slow,
 * but finite: a call that hangs would otherwise leave an analysis sitting on a
 * step for ever, which is the failure mode the timeline exists to prevent.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** One item of an MCP tool result. Text and images are the two Figma returns. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/** What the adapter needs, and nothing else. */
export interface McpSession {
  call(tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  url?: string;
  timeoutMs?: number;
}

/**
 * Recognises a connection that was refused.
 *
 * Node reports this as a cause chain rather than a flat code, and the SDK wraps
 * it again, so the whole chain is searched rather than the top-level message.
 */
function isConnectionRefused(error: unknown): boolean {
  const codes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'fetch failed'];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message = current instanceof Error ? `${current.message} ${String(Reflect.get(current, 'code') ?? '')}` : String(current);
    if (codes.some((code) => message.includes(code))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Turns whatever the SDK threw into a failure with a reason and a place. */
export function classifyMcpError(error: unknown, where: string, url: string): DesignSourceError {
  if (error instanceof DesignSourceError) return error;

  if (isConnectionRefused(error)) {
    return new DesignSourceError(
      'unreachable',
      where,
      `nothing is listening at ${url} -- the Figma desktop app is not running, or its local ` +
        'MCP server is not enabled in Preferences',
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|aborted|AbortError/i.test(message)) {
    return new DesignSourceError('timeout', where, `${where} did not answer in time`);
  }

  return new DesignSourceError('protocol', where, `${where} failed: ${message}`);
}

/**
 * Opens a session against the local Figma MCP server.
 *
 * The connection is made eagerly rather than on the first call, so "Figma is
 * not running" is reported before an analysis has read a ticket and written
 * anything to disk.
 */
export async function openFigmaSession(options: OpenSessionOptions = {}): Promise<McpSession> {
  const url = options.url ?? FIGMA_MCP_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  const client = new Client({ name: 'ai-studio', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));

  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw classifyMcpError(error, 'connecting to the Figma MCP server', url);
  }

  return {
    async call(tool, args) {
      try {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: timeoutMs,
        });
        return {
          content: (result.content ?? []) as McpContent[],
          ...(result.isError === true ? { isError: true } : {}),
        };
      } catch (error) {
        throw classifyMcpError(error, tool, url);
      }
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

/** The text of a tool result, concatenated. Empty when it returned none. */
export function textOfResult(result: McpToolResult): string {
  return result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

/** The first image in a tool result, as bytes. */
export function imageOfResult(result: McpToolResult): { bytes: Buffer; mimeType: string } | null {
  for (const item of result.content) {
    if (item.type !== 'image') continue;
    const data = Reflect.get(item, 'data');
    const mimeType = Reflect.get(item, 'mimeType');
    if (typeof data !== 'string') continue;
    return {
      bytes: Buffer.from(data, 'base64'),
      mimeType: typeof mimeType === 'string' ? mimeType : 'image/png',
    };
  }
  return null;
}
