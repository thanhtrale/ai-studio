import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { PARTIAL_SUFFIX, sanitiseTransferName, type InboxFile, type LanStatus, type Peer } from '#shared/lan';

/** Received files live beside the library, not in it: they are not media the arms made. */
export function inboxDir(storageDir: string): string {
  return path.join(storageDir, 'lan-inbox');
}

/** Resolves a name from a request to a file inside the inbox, or null. */
export function inboxPath(storageDir: string, name: unknown): string | null {
  const safe = typeof name === 'string' ? sanitiseTransferName(name) : null;
  return safe === null || safe !== name ? null : path.join(inboxDir(storageDir), safe);
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry!.address);
}

async function listInbox(dir: string): Promise<InboxFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(PARTIAL_SUFFIX))
      .map(async (entry) => {
        const stats = await stat(path.join(dir, entry.name));
        return { name: entry.name, bytes: stats.size, receivedAt: stats.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** `a.txt`, then `a (1).txt`, `a (2).txt`: a second send never overwrites the first. */
async function freeName(dir: string, name: string): Promise<string> {
  const { name: stem, ext } = path.parse(name);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
    try {
      await stat(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
}

/**
 * Streams one request body into the inbox. It is written under a partial name
 * and renamed on the last byte, so the inbox never lists half a file and an
 * interrupted send leaves nothing behind.
 */
async function receive(dir: string, name: string, body: IncomingMessage): Promise<string> {
  await mkdir(dir, { recursive: true });
  const partial = path.join(dir, `${randomUUID()}${PARTIAL_SUFFIX}`);
  try {
    await pipeline(body, createWriteStream(partial));
    const final = await freeName(dir, name);
    await rename(partial, path.join(dir, final));
    return final;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

// On globalThis so a dev-server reload of this module finds the socket it
// already holds instead of failing to bind the port a second time.
const held = globalThis as { __aistudioLan?: { server: Server; port: number } };

export function isListening(): boolean {
  return held.__aistudioLan !== undefined;
}

/**
 * The only thing this studio exposes to the network: a hello and a write-only
 * inbox. The console itself stays on loopback.
 */
export async function startListener(storageDir: string, port: number): Promise<void> {
  if (held.__aistudioLan) return;
  const dir = inboxDir(storageDir);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://lan');
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/lan/hello') {
      return reply(200, { app: 'ai-studio', hostname: hostname() });
    }

    if (req.method === 'PUT' && url.pathname === '/lan/inbox') {
      const name = sanitiseTransferName(url.searchParams.get('name') ?? '');
      if (name === null) return reply(400, { message: 'not a usable file name' });

      receive(dir, name, req).then(
        (saved) => {
          console.log(`[lan] received ${saved} from ${req.socket.remoteAddress}`);
          reply(200, { name: saved });
        },
        (error: Error) => {
          if (!res.headersSent && !res.destroyed) reply(500, { message: error.message });
        },
      );
      return;
    }

    reply(404, { message: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use`) : error),
    );
    server.listen(port, '0.0.0.0', resolve);
  });
  held.__aistudioLan = { server, port };
}

export async function stopListener(): Promise<void> {
  const current = held.__aistudioLan;
  if (!current) return;
  held.__aistudioLan = undefined;
  current.server.closeAllConnections();
  await new Promise((resolve) => current.server.close(resolve));
}

export async function lanStatus(storageDir: string, port: number): Promise<LanStatus> {
  return {
    listening: isListening(),
    port,
    hostname: hostname(),
    addresses: lanAddresses(),
    inbox: await listInbox(inboxDir(storageDir)),
  };
}

/** Asks a peer's listener who it is. Short timeout: a wrong address should say so quickly. */
export async function helloPeer(peer: Peer): Promise<{ hostname: string }> {
  const response = await fetch(`http://${peer.host}:${peer.port}/lan/hello`, {
    signal: AbortSignal.timeout(3000),
  });
  const body = (await response.json()) as { app?: string; hostname?: string };
  if (body.app !== 'ai-studio') throw new Error('something answered, but it is not an AI Studio LAN listener');
  return { hostname: body.hostname ?? peer.host };
}

/** Relays a request body to a peer's inbox as it arrives, without holding it in memory. */
export function forwardToPeer(
  peer: Peer,
  name: string,
  body: IncomingMessage,
): Promise<{ status: number; payload: { name?: string; message?: string } }> {
  return new Promise((resolve, reject) => {
    const length = body.headers['content-length'];
    const outgoing = request(
      {
        host: peer.host,
        port: peer.port,
        method: 'PUT',
        path: `/lan/inbox?name=${encodeURIComponent(name)}`,
        headers: length ? { 'content-length': length } : {},
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode ?? 502, payload: JSON.parse(text) });
          } catch {
            resolve({ status: 502, payload: { message: `peer answered ${response.statusCode}` } });
          }
        });
      },
    );
    outgoing.on('error', reject);
    pipeline(body, outgoing).catch(reject);
  });
}
