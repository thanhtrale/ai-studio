/**
 * Jira's XML issue export into one normalised ticket.
 *
 * The export is RSS 0.92 with a single `<item>`, and its `<description>` is
 * entity-escaped HTML. So the document is read at two levels: the tokeniser
 * resolves the entities as it builds the XML tree, and what comes out of the
 * description element is HTML that then gets parsed again.
 *
 * This is the richest import path and the one worth pushing users towards. It
 * is the only one that carries comments, custom fields and attachment names,
 * and comments matter more than they look: a requirement agreed in a thread and
 * never written back into the description exists only there.
 */

import type { NormalisedTicket, TicketAttachment, TicketComment, TicketPassage } from '#shared/analysis';

import { htmlToMarkdown } from '../html-to-markdown';
import type { MarkupElement } from '../markup';
import { childrenNamed, find, findAll, parseMarkup, textOf, textOfChild } from '../markup';

/**
 * Custom fields that never say anything about the requirement.
 *
 * Jira attaches these to every issue whether or not the project uses them, and
 * a ranking token or an empty development panel in the model's context is pure
 * cost. Matched on the plugin key, which is stable, rather than on the display
 * name, which is not.
 */
const NOISE_FIELD_KEYS = [
  'com.pyxis.greenhopper.jira:gh-lexo-rank',
  'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf',
  'com.atlassian.jira.ext.charting:',
  'com.atlassian.jpo:jpo-custom-field-',
];

function isNoise(key: string): boolean {
  return NOISE_FIELD_KEYS.some((prefix) => key.startsWith(prefix));
}

/**
 * Cuts a description into citable passages at its headings.
 *
 * Ids are ordinals -- `p1`, `p2` -- and short on purpose. They were first the
 * source's own anchors, slugified, which read beautifully and transcribed
 * terribly: a real run lost 28 of 61 claims to a model citing
 * `sitevisitor-guestuserexperience` for the passage actually named
 * `scenariossitevisitor-guestuserexperience`, and `Introduction` for the one
 * named `intro`. Forty characters of run-together lowercase is not something
 * to ask anything to copy exactly. `p3` is.
 *
 * The anchor is kept on the passage, decoded, because it is what makes a
 * citation mean something to a person reading the output.
 */
export function splitPassages(
  markdown: string,
  anchors: readonly { name: string; heading: string }[],
): TicketPassage[] {
  const byHeading = new Map<string, string>();
  for (const anchor of anchors) {
    if (!byHeading.has(anchor.heading)) byHeading.set(anchor.heading, anchor.name);
  }

  const lines = markdown.split('\n');
  const passages: TicketPassage[] = [];

  let heading = '';
  let body: string[] = [];

  const push = (): void => {
    // A trailing rule is the separator before the next heading, not content of
    // this passage. Left in, every passage ends with one.
    const text = body.join('\n').trim().replace(/\n*^---$/m, '').trim();
    body = [];
    if (!heading && !text) return;

    const passage: TicketPassage = {
      id: `p${passages.length + 1}`,
      heading: heading || 'Introduction',
      body: text,
    };

    const anchor = byHeading.get(heading);
    if (anchor) {
      // Percent-encoded by Confluence. Decoded for a reader; a malformed one
      // is kept as written rather than throwing.
      try {
        passage.anchor = decodeURIComponent(anchor);
      } catch {
        passage.anchor = anchor;
      }
    }

    passages.push(passage);
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match?.[2] !== undefined) {
      push();
      heading = match[2].replace(/\*\*/g, '').trim();
      continue;
    }
    body.push(line);
  }
  push();

  return passages.filter((passage) => passage.body || passage.heading !== 'Introduction');
}

function readComments(item: MarkupElement): TicketComment[] {
  const container = find(item, 'comments');
  if (!container) return [];

  return childrenNamed(container, 'comment').map((node, index) => {
    const { markdown } = htmlToMarkdown(textOf(node));
    const comment: TicketComment = {
      id: node.attrs['id'] ?? `comment-${index + 1}`,
      body: markdown,
    };
    const created = node.attrs['created'];
    if (created) comment.createdAt = created;
    return comment;
  });
}

function readAttachments(item: MarkupElement): TicketAttachment[] {
  const container = find(item, 'attachments');
  if (!container) return [];

  return findAll(container, 'attachment').map((node, index) => {
    const attachment: TicketAttachment = {
      id: node.attrs['id'] ?? `attachment-${index + 1}`,
      name: node.attrs['name'] ?? 'unnamed',
    };
    const size = Number.parseInt(node.attrs['size'] ?? '', 10);
    if (Number.isFinite(size)) attachment.bytes = size;
    return attachment;
  });
}

function readCustomFields(item: MarkupElement): Record<string, string> | undefined {
  const container = find(item, 'customfields');
  if (!container) return undefined;

  const fields: Record<string, string> = {};
  for (const field of findAll(container, 'customfield')) {
    const key = field.attrs['key'] ?? '';
    if (isNoise(key)) continue;

    const name = textOfChild(field, 'customfieldname');
    if (!name) continue;

    const values = findAll(field, 'customfieldvalue')
      .map((node) => textOf(node).trim())
      .filter(Boolean);
    // An empty custom field is not a fact about the issue.
    if (values.length === 0) continue;

    fields[name] = values.join(', ');
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** Parses a Jira XML issue export. Fields the export omits stay absent. */
export function parseJiraXml(source: string): NormalisedTicket {
  const root = parseMarkup(source);
  const item = find(root, 'item');
  if (!item) {
    throw new Error('the export carries no <item>, so there is no issue in it');
  }

  const { markdown, anchors } = htmlToMarkdown(textOf(find(item, 'description') ?? item));

  const ticket: NormalisedTicket = {
    format: 'jira-xml',
    description: markdown,
    passages: splitPassages(markdown, anchors),
    comments: readComments(item),
    attachments: readAttachments(item),
  };

  const assign = <K extends keyof NormalisedTicket>(key: K, value: string): void => {
    if (value) (ticket[key] as unknown as string) = value;
  };

  assign('key', textOfChild(item, 'key'));
  assign('summary', textOfChild(item, 'summary'));
  assign('type', textOfChild(item, 'type'));
  assign('status', textOfChild(item, 'status'));
  assign('priority', textOfChild(item, 'priority'));
  assign('parent', textOfChild(item, 'parent'));
  assign('createdAt', textOfChild(item, 'created'));
  assign('updatedAt', textOfChild(item, 'updated'));

  const labels = find(item, 'labels');
  if (labels) {
    const values = findAll(labels, 'label')
      .map((node) => textOf(node).trim())
      .filter(Boolean);
    if (values.length > 0) ticket.labels = values;
  }

  const fields = readCustomFields(item);
  if (fields) ticket.fields = fields;

  return ticket;
}
