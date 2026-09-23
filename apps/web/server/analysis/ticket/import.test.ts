import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RelayError } from '../../utils/supervisor';
import { importTicket } from './import';

const FIXTURE = readFileSync(path.join(import.meta.dirname, 'fixtures/jira-cap-59.xml'));

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('importTicket', () => {
  it('reads the XML export, which carries the most', async () => {
    const { ticket, detail } = await importTicket({ bytes: FIXTURE });
    expect(ticket.format).toBe('jira-xml');
    expect(ticket.key).toBe('CAP-59');
    expect(ticket.comments).toHaveLength(1);
    expect(detail).toMatch(/XML issue export/);
  });

  it('reads a Word export, which is HTML in a .doc', async () => {
    const { ticket } = await importTicket({
      bytes: encode('<html><body><h1>[CAP-59] Featured Story Card</h1><p>Body.</p></body></html>'),
    });
    expect(ticket.format).toBe('html');
    expect(ticket.key).toBe('CAP-59');
    expect(ticket.summary).toBe('Featured Story Card');
  });

  it('accepts pasted text with no file', async () => {
    const { ticket, detail } = await importTicket({ text: 'As a visitor I want to read a story.' });
    expect(ticket.format).toBe('text');
    expect(ticket.description).toBe('As a visitor I want to read a story.');
    expect(detail).toBe('pasted text');
  });

  it('finds headings in pasted text, so a passage can be cited', async () => {
    const { ticket } = await importTicket({
      text: 'Acceptance Criteria\n\nThe block shows three cards.\n',
    });
    expect(ticket.passages.map((passage) => passage.heading)).toContain('Acceptance Criteria');
  });

  it('refuses an empty ticket before anything expensive starts', async () => {
    await expect(importTicket({})).rejects.toThrow(RelayError);
    await expect(importTicket({ text: '   ' })).rejects.toThrow(/a ticket is required/);
  });

  it('refuses a binary, naming what it turned out to be', async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(importTicket({ bytes: docx })).rejects.toThrow(/zip archive/);

    const legacyDoc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
    await expect(importTicket({ bytes: legacyDoc })).rejects.toThrow(/legacy Word binary/);
  });

  it('points a refused binary at the export that does work', async () => {
    await expect(importTicket({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) })).rejects.toThrow(
      /export the issue as XML/,
    );
  });

  it('refuses an empty file', async () => {
    await expect(importTicket({ bytes: encode('   ') })).rejects.toThrow(/empty/);
  });

  it('refuses a file larger than the cap', async () => {
    await expect(importTicket({ bytes: new Uint8Array(21 * 1024 * 1024) })).rejects.toThrow(/larger than/);
  });

  it('refuses markup that parsed but held nothing', async () => {
    // An RSS feed with no <item> would otherwise become an empty ticket that
    // four model passes then read very carefully.
    await expect(importTicket({ bytes: encode('<rss><channel></channel></rss>') })).rejects.toThrow(
      /no readable text .* RSS feed with no issue/,
    );
  });

  it('reports a malformed XML export with its reason', async () => {
    await expect(
      importTicket({ bytes: encode('<rss><channel><item-ish/></channel></rss>') }),
    ).rejects.toThrow(RelayError);
  });
});
