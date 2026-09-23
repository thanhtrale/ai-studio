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
