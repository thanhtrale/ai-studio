/**
 * One imported file or one pasted passage, into one normalised ticket.
 *
 * Every path ends in the same shape. What differs is how much of it a format
 * can fill: the XML export carries comments, custom fields and attachment
 * names; a printed PDF carries the words and nothing that says which were a
 * heading. Fields a format cannot supply stay absent, because a guessed status
 * is worse than none.
 */

import type { NormalisedTicket } from '#shared/analysis';

import { htmlToMarkdown } from '../html-to-markdown';
import { RelayError } from '../../utils/supervisor';
import { parseJiraXml, splitPassages } from './jira-xml';
import { pdfToText } from './pdf';
import { describeBinary, looksBinary, sniffTicketFormat } from './sniff';

/** Generous: a printed issue with screenshots is large, and this is a local tool. */
const MAX_TICKET_BYTES = 20 * 1024 * 1024;

/**
 * Cuts plain text into passages at anything that reads as a heading.
 *
 * Markdown hashes where a person wrote them, and otherwise a short line
 * followed by a blank one -- which is what a heading looks like once a PDF has
 * thrown away the fact that it was one.
 */
function passagesFromText(text: string): NormalisedTicket['passages'] {
  const markdown = text
    .split('\n')
    .map((line, index, all) => {
      if (/^#{1,6}\s/.test(line)) return line;
      const trimmed = line.trim();
      const next = all[index + 1]?.trim() ?? '';
      const looksLikeHeading =
        trimmed.length > 0 && trimmed.length <= 80 && next === '' && !/[.,;:]$/.test(trimmed);
      return looksLikeHeading ? `## ${trimmed}` : line;
    })
    .join('\n');

  return splitPassages(markdown, []);
}

function fromText(text: string, format: NormalisedTicket['format']): NormalisedTicket {
  return {
    format,
    description: text.trim(),
    passages: passagesFromText(text),
    comments: [],
    attachments: [],
  };
}

function fromHtml(html: string): NormalisedTicket {
  const { markdown, anchors } = htmlToMarkdown(html);
  const ticket: NormalisedTicket = {
    format: 'html',
    description: markdown,
    passages: splitPassages(markdown, anchors),
    comments: [],
    attachments: [],
  };

  // Jira's Word export leads with the issue key and summary as the first
  // heading. Reading it is a guess, but a checkable one: it either matches the
  // shape or the fields stay absent.
  //
  // Matched against the unescaped text: the converter escapes `[` and `]`, so
  // a key really arrives as `\[CAP-59\]`.
  const plain = markdown.replace(/\\([\\`*_[\]])/g, '$1');
  const heading = /^#{1,6}\s+\[?([A-Z][A-Z0-9]+-\d+)\]?\s*[-–:]?\s*(.*)$/m.exec(plain);
  if (heading?.[1]) ticket.key = heading[1];
  if (heading?.[2]?.trim()) ticket.summary = heading[2].trim();

  return ticket;
}

export interface ImportedTicket {
  ticket: NormalisedTicket;
  /** What the file appeared to be, for the console to show. */
  detail: string;
}

/**
 * Reads whatever arrived.
 *
 * `bytes` is a file the user picked; `text` is what they pasted. Exactly one is
 * expected, and neither means there is no ticket -- which is refused here
 * rather than three steps later when a pass has nothing to read.
 */
export async function importTicket(input: {
  bytes?: Uint8Array;
  text?: string;
}): Promise<ImportedTicket> {
  const pasted = input.text?.trim();

  if (!input.bytes?.length) {
    if (!pasted) throw new RelayError('invalid_request', 'a ticket is required: import a file or paste one');
    return { ticket: fromText(pasted, 'text'), detail: 'pasted text' };
  }

  if (input.bytes.length > MAX_TICKET_BYTES) {
    throw new RelayError('invalid_request', `that file is larger than ${MAX_TICKET_BYTES / 1024 / 1024} MB`);
  }

  if (looksBinary(input.bytes)) {
    throw new RelayError(
      'invalid_request',
      `that file is ${describeBinary(input.bytes)}, which this studio cannot read -- ` +
        'export the issue as XML instead, which carries more anyway',
    );
  }

  const { format, detail } = sniffTicketFormat(input.bytes);

  if (format === 'pdf') {
    const text = await pdfToText(input.bytes);
    if (!text) {
      throw new RelayError(
        'invalid_request',
        'that PDF carried no text -- it may be a scan, and a scan of an issue is a picture of one',
      );
    }
    return { ticket: fromText(text, 'pdf'), detail };
  }

  const source = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes);

  if (format === 'jira-xml') {
    try {
      return { ticket: parseJiraXml(source), detail };
    } catch (error) {
      throw new RelayError('invalid_request', `that XML export could not be read: ${(error as Error).message}`);
    }
  }

  if (!source.trim()) throw new RelayError('invalid_request', 'that file is empty');

  const ticket = format === 'html' ? fromHtml(source) : fromText(source, 'text');

  // Markup that parsed but held nothing. An RSS feed with no `<item>` lands
  // here, and so does a page of navigation chrome -- both would otherwise
  // become an empty ticket that four model passes then read very carefully.
  if (!ticket.description.trim()) {
    throw new RelayError(
      'invalid_request',
      `that file carried no readable text -- it looked like ${detail}`,
    );
  }

  return { ticket, detail };
}
