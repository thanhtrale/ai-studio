/**
 * What an imported ticket actually is.
 *
 * Decided from the bytes, never from the filename, because the filename lies:
 * Jira's "Word" export is HTML in a `.doc`, and its XML export is served as
 * whatever the browser decided to call it. A `.doc` refused for not being a
 * Word binary would refuse the format users are most likely to arrive with.
 */

import type { TicketFormat } from '#shared/analysis';

export interface SniffResult {
  format: TicketFormat;
  /** What it appeared to be, for a message when it cannot be read. */
  detail: string;
}

/** PDF's magic number. The only format here identified by bytes rather than markup. */
const PDF_MAGIC = '%PDF-';

/**
 * Markup the document may open with before its real root.
 *
 * A Jira XML export begins with an HTML comment naming the build that wrote it
 * -- there is no XML declaration at all -- so the root tag has to be found past
 * whatever preamble is there rather than assumed to be first.
 */
function firstTag(text: string): string | null {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open === -1) return null;

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) return null;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) return null;
      cursor = end + 2;
      continue;
    }
    if (text.startsWith('<!', open)) {
      const end = text.indexOf('>', open + 2);
      if (end === -1) return null;
      cursor = end + 1;
      continue;
    }

    const match = /^<([A-Za-z_:][-A-Za-z0-9_:.]*)/.exec(text.slice(open, open + 64));
    if (match?.[1]) return match[1].toLowerCase();
    cursor = open + 1;
  }
  return null;
}

const HTML_ROOTS = new Set(['html', 'body', 'div', 'p', 'table', 'h1', 'h2', 'h3', 'span', 'ul', 'ol']);

/**
 * Identifies an imported ticket.
 *
 * Never throws and always answers: an unrecognised text file is `text`, which
 * is usable, and only a file that is not text at all is reported as such by the
 * caller refusing it.
 */
export function sniffTicketFormat(input: string | Uint8Array): SniffResult {
  const text =
    typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);

  if (text.startsWith(PDF_MAGIC)) {
    return { format: 'pdf', detail: 'a PDF, most likely the issue print view' };
  }

  // A PDF whose header sits behind a byte-order mark or stray whitespace.
  if (text.slice(0, 1024).includes(PDF_MAGIC)) {
    return { format: 'pdf', detail: 'a PDF' };
  }

  const root = firstTag(text);

  if (root === 'rss' || root === 'channel') {
    // Jira's export is RSS 0.92 carrying one `<item>`. Requiring the item
    // distinguishes it from any other feed that might be dropped in.
    if (/<item[\s>]/.test(text)) {
      return { format: 'jira-xml', detail: "Jira's XML issue export" };
    }
    return { format: 'html', detail: 'an RSS feed with no issue in it' };
  }

  if (root !== null && HTML_ROOTS.has(root)) {
    return { format: 'html', detail: `HTML (root <${root}>), which is what Jira's Word export contains` };
  }

  if (root !== null) {
    return { format: 'html', detail: `markup with a <${root}> root` };
  }

  if (text.trim()) return { format: 'text', detail: 'plain text' };

  return { format: 'text', detail: 'empty' };
}

/** True when the bytes are not text this studio can read at all. */
export function looksBinary(input: Uint8Array): boolean {
  if (input.length === 0) return false;
  if (input[0] === 0x25 && input[1] === 0x50) return false; // %P -- a PDF, handled above.

  // A Word binary (OLE compound file) or a .docx (zip) arrives here; neither is
  // what Jira's "Word" export produces, and neither can be read without a
  // dependency this studio does not carry.
  const head = Array.from(input.slice(0, 8));
  const startsWith = (bytes: number[]): boolean => bytes.every((byte, index) => head[index] === byte);
  if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) return true; // OLE2 / legacy .doc
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return true; // zip / .docx / .xlsx

  // Otherwise: a null byte in the first kilobyte means this is not text.
  return input.slice(0, 1024).includes(0);
}

/** A human-readable name for what a binary turned out to be. */
export function describeBinary(input: Uint8Array): string {
  const head = Array.from(input.slice(0, 4));
  const startsWith = (bytes: number[]): boolean => bytes.every((byte, index) => head[index] === byte);
  if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) return 'a legacy Word binary (.doc)';
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return 'a zip archive, such as .docx or .xlsx';
  return 'a binary file';
}
