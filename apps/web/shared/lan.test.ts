import { describe, expect, it } from 'vitest';

import {
  PEER_TTL_MS,
  broadcastAddress,
  livePeers,
  parseBeacon,
  parsePeer,
  sanitiseTransferName,
  type DiscoveredPeer,
} from './lan';

describe('sanitiseTransferName', () => {
  it('keeps an ordinary name, extension and all', () => {
    expect(sanitiseTransferName('Báo cáo Q3.xlsx')).toBe('Báo cáo Q3.xlsx');
    expect(sanitiseTransferName('setup.exe')).toBe('setup.exe');
  });

  it('drops any directory part, either separator', () => {
    expect(sanitiseTransferName('../../etc/passwd')).toBe('passwd');
    expect(sanitiseTransferName('C:\\Users\\x\\notes.txt')).toBe('notes.txt');
  });

  it('replaces characters Windows refuses and trailing dots', () => {
    expect(sanitiseTransferName('a<b>:c?.txt')).toBe('a_b__c_.txt');
    expect(sanitiseTransferName('name. . ')).toBe('name');
  });

  it('escapes device names', () => {
    expect(sanitiseTransferName('con.txt')).toBe('_con.txt');
    expect(sanitiseTransferName('NUL')).toBe('_NUL');
  });

  it('rejects what cannot be a file', () => {
    expect(sanitiseTransferName('')).toBeNull();
    expect(sanitiseTransferName('..')).toBeNull();
    expect(sanitiseTransferName('dir/')).toBeNull();
    expect(sanitiseTransferName('x.lan-part')).toBeNull();
  });
});

describe('parsePeer', () => {
  it('fills in the default port', () => {
    expect(parsePeer('10.0.0.5', 3001)).toEqual({ host: '10.0.0.5', port: 3001 });
  });

  it('takes a port or a whole url', () => {
    expect(parsePeer(' 10.0.0.5:4000 ', 3001)).toEqual({ host: '10.0.0.5', port: 4000 });
    expect(parsePeer('http://desktop-1:4000/', 3001)).toEqual({ host: 'desktop-1', port: 4000 });
  });

  it('rejects anything that is not plain http to a host', () => {
    expect(parsePeer('', 3001)).toBeNull();
    expect(parsePeer('https://10.0.0.5', 3001)).toBeNull();
    expect(parsePeer('not a host', 3001)).toBeNull();
  });
});

describe('parseBeacon', () => {
  const good = { app: 'ai-studio', id: 'abc', hostname: 'DESKTOP-1', port: 3001 };

  it('reads a beacon', () => {
    expect(parseBeacon(JSON.stringify(good))).toEqual(good);
  });

  it('ignores whatever else shares the port', () => {
    expect(parseBeacon('hello')).toBeNull();
    expect(parseBeacon('null')).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, app: 'other' }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, id: '' }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, port: 0 }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, port: 70000 }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, port: '3001' }))).toBeNull();
  });

  it('drops fields it does not know and caps the hostname', () => {
    const parsed = parseBeacon(JSON.stringify({ ...good, hostname: 'x'.repeat(500), extra: 1 }));
    expect(parsed).toEqual({ ...good, hostname: 'x'.repeat(100) });
  });
});

describe('livePeers', () => {
  const peer = (id: string, hostname: string, seenAt: number): DiscoveredPeer => ({
    id,
    hostname,
    host: `10.0.0.${id}`,
    port: 3001,
    seenAt,
  });

  it('keeps the recent ones, sorted by name', () => {
    const now = 100_000;
    const peers = [peer('1', 'zeta', now), peer('2', 'alpha', now - 1000), peer('3', 'gone', now - PEER_TTL_MS - 1)];
    expect(livePeers(peers, now).map((p) => p.hostname)).toEqual(['alpha', 'zeta']);
  });
});

describe('broadcastAddress', () => {
  it('fills the host bits', () => {
    expect(broadcastAddress('192.168.1.20', '255.255.255.0')).toBe('192.168.1.255');
    expect(broadcastAddress('10.1.2.3', '255.255.0.0')).toBe('10.1.255.255');
    expect(broadcastAddress('172.16.5.9', '255.255.255.252')).toBe('172.16.5.11');
  });

  it('refuses what is not an IPv4 pair', () => {
    expect(broadcastAddress('fe80::1', 'ffff::')).toBeNull();
    expect(broadcastAddress('192.168.1', '255.255.255.0')).toBeNull();
    expect(broadcastAddress('192.168.1.300', '255.255.255.0')).toBeNull();
  });
});
