import { randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { hostname, networkInterfaces } from 'node:os';

import {
  BEACON_INTERVAL_MS,
  broadcastAddress,
  livePeers,
  parseBeacon,
  type Beacon,
  type DiscoveredPeer,
} from '#shared/lan';

/**
 * Finding receivers without typing an address.
 *
 * An open inbox broadcasts a small beacon on every LAN interface; a sender
 * listens for them while its LAN page is open. Nothing new is reachable: the
 * beacon only names the listener port that is already open, and the scanner
 * only reads datagrams.
 */

/** Stops listening for beacons once no page has asked for peers in this long. */
const SCAN_IDLE_MS = 15_000;

// On globalThis for the same reason as the listener: a dev reload must find the
// sockets it already holds instead of opening a second set.
const held = globalThis as {
  __aistudioLanId?: string;
  __aistudioBeacon?: { socket: Socket; timer: ReturnType<typeof setInterval> };
  __aistudioScan?: { socket: Socket; peers: Map<string, DiscoveredPeer>; idle: ReturnType<typeof setTimeout> };
};

/** This studio's id in beacons, so it can leave itself out of what it hears. */
function selfId(): string {
  return (held.__aistudioLanId ??= randomUUID());
}

function broadcastAddresses(): string[] {
  const found = new Set<string>();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
    const address = broadcastAddress(entry.address, entry.netmask);
    if (address) found.add(address);
  }
  return [...found];
}

export async function startBeacon(listenerPort: number, discoveryPort: number): Promise<void> {
  if (held.__aistudioBeacon) return;

  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  // A failed send (an interface went away, a VPN adapter refuses broadcast) is
  // not worth stopping for: the next tick tries every interface again.
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.bind(0, resolve));
  socket.setBroadcast(true);

  const announce = () => {
    const beacon: Beacon = { app: 'ai-studio', id: selfId(), hostname: hostname(), port: listenerPort };
    const payload = Buffer.from(JSON.stringify(beacon));
    for (const address of broadcastAddresses()) {
      socket.send(payload, discoveryPort, address, () => {});
    }
  };
  announce();
  held.__aistudioBeacon = { socket, timer: setInterval(announce, BEACON_INTERVAL_MS) };
}

export function stopBeacon(): void {
  const current = held.__aistudioBeacon;
  if (!current) return;
  held.__aistudioBeacon = undefined;
  clearInterval(current.timer);
  current.socket.close();
}

function stopScan(): void {
  const current = held.__aistudioScan;
  if (!current) return;
  held.__aistudioScan = undefined;
  clearTimeout(current.idle);
  current.socket.close();
}

/**
 * The receivers heard from recently. The first call starts listening, so the
 * list fills over the next beacon interval; each call keeps it going a while longer.
 */
export async function discoveredPeers(discoveryPort: number): Promise<DiscoveredPeer[]> {
  let scan = held.__aistudioScan;
  if (!scan) {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const peers = new Map<string, DiscoveredPeer>();

    socket.on('message', (message, from) => {
      const beacon = parseBeacon(message.toString('utf8'));
      if (!beacon || beacon.id === selfId()) return;
      // The address the datagram came from, not one the beacon claims: it is the
      // one that is known to route back to the sender.
      peers.set(beacon.id, {
        id: beacon.id,
        hostname: beacon.hostname,
        host: from.address,
        port: beacon.port,
        seenAt: Date.now(),
      });
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(discoveryPort, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.on('error', stopScan);

    scan = { socket, peers, idle: setTimeout(stopScan, SCAN_IDLE_MS) };
    held.__aistudioScan = scan;
  }

  scan.idle.refresh();
  const now = Date.now();
  const live = livePeers(scan.peers.values(), now);
  for (const [id, peer] of scan.peers) if (!live.includes(peer)) scan.peers.delete(id);
  return live;
}

export function stopDiscovery(): void {
  stopBeacon();
  stopScan();
}
