/**
 * LAN transfer: what the browser and the server agree on.
 *
 * One studio sends a file to another over the local network. The browser only
 * ever talks to its own studio on loopback; the studio relays the bytes to the
 * peer's LAN listener, so nothing about the web console is exposed to the network.
 */

/** The port the LAN listener binds when `AISTUDIO_LAN_PORT` does not say otherwise. */
export const DEFAULT_LAN_PORT = 3001;

/** A file is written under this suffix until its last byte lands, then renamed. */
export const PARTIAL_SUFFIX = '.lan-part';

export interface InboxFile {
  name: string;
  bytes: number;
  receivedAt: string;
}

export interface LanStatus {
  listening: boolean;
  port: number;
  hostname: string;
  /** This machine's IPv4 addresses, for the other side to type in. */
  addresses: string[];
  inbox: InboxFile[];
}

export interface Peer {
  host: string;
  port: number;
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Keeps the name a sender chose, minus anything that would escape the inbox or
 * that Windows refuses. Unlike library uploads the extension is not policed:
 * the inbox holds whatever someone wanted to move, not media the studio shows.
 */
export function sanitiseTransferName(original: string): string | null {
  const last = original.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 200);

  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  if (cleaned.endsWith(PARTIAL_SUFFIX)) return null;

  const dot = cleaned.indexOf('.');
  const stem = dot === -1 ? cleaned : cleaned.slice(0, dot);
  return WINDOWS_DEVICE.test(stem) ? `_${cleaned}` : cleaned;
}

/** `10.0.0.5`, `10.0.0.5:3001` or `http://10.0.0.5:3001/` -> host and port. */
export function parsePeer(raw: string, defaultPort: number): Peer | null {
  const text = raw.trim();
  if (text === '') return null;

  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname === '') return null;

  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port === '' ? defaultPort : Number(url.port),
  };
}

// ---- Discovery ------------------------------------------------------------

/**
 * The UDP port receivers announce themselves on. Fixed rather than derived from
 * the listener port: a sender has to know where to listen before it knows anyone.
 */
export const DEFAULT_DISCOVERY_PORT = 3001;

/** How often an open inbox announces itself, and how long a silent one stays listed. */
export const BEACON_INTERVAL_MS = 2000;
export const PEER_TTL_MS = 7000;

/** What an open inbox broadcasts. `id` tells one studio from another on the same host. */
export interface Beacon {
  app: 'ai-studio';
  id: string;
  hostname: string;
  port: number;
}

export interface DiscoveredPeer extends Peer {
  id: string;
  hostname: string;
  seenAt: number;
}

/** A datagram off the wire -> a beacon, or null for anything else that shares the port. */
export function parseBeacon(raw: string): Beacon | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const beacon = value as Partial<Beacon> | null;
  if (
    beacon?.app !== 'ai-studio' ||
    typeof beacon.id !== 'string' ||
    beacon.id === '' ||
    typeof beacon.hostname !== 'string' ||
    !Number.isInteger(beacon.port) ||
    beacon.port! < 1 ||
    beacon.port! > 65535
  ) {
    return null;
  }
  return { app: 'ai-studio', id: beacon.id, hostname: beacon.hostname.slice(0, 100), port: beacon.port! };
}

/** The peers heard from recently, newest name first; stale ones are gone. */
export function livePeers(peers: Iterable<DiscoveredPeer>, now: number): DiscoveredPeer[] {
  return [...peers]
    .filter((peer) => now - peer.seenAt <= PEER_TTL_MS)
    .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.host.localeCompare(b.host));
}

/** `192.168.1.20` with `255.255.255.0` -> `192.168.1.255`. */
export function broadcastAddress(address: string, netmask: string): string | null {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return a.map((octet, i) => (octet | (~m[i]! & 255)) & 255).join('.');
}
