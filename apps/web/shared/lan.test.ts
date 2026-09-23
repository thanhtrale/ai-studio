import { describe, expect, it } from 'vitest';

import { parsePeer, sanitiseTransferName } from './lan';

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
