/**
 * Confluence-rendered HTML into Markdown, with the structure intact.
 *
 * Structure is the whole point. A ticket's acceptance criteria are a list and
 * its authoring specification is a table; flattening either to prose loses the
 * thing a reader -- or a model -- needs to enumerate. So lists stay lists,
 * tables stay tables, and headings stay headings so the description can be cut
 * into citable passages.
 */

import type { MarkupElement, MarkupNode } from './markup';
import { HTML_VOID_TAGS, findAll, isElement, parseMarkup, textOf } from './markup';

/**
 * The Confluence wiki cell separator.
 *
 * It matters here because of what it does to a table: an author who types a
 * literal `|` inside a cell -- specifying, say, a divider glyph -- has that
 * character read as a cell boundary, and the rendered row comes out with more
 * cells than the header has columns. Rejoining the overflow with this character
 * is the exact inverse of the split, so the sentence comes back whole.
 */
const CELL_SEPARATOR = '|';

export interface HtmlAnchor {
  /** The `name` attribute of an empty `<a>`, which Confluence puts before a heading. */
  name: string;
  /** The heading text that followed it. */
  heading: string;
  level: number;
}

export interface HtmlConversion {
  markdown: string;
  /** Anchors found before headings, in document order. Passage ids come from these. */
  anchors: HtmlAnchor[];
  /** `<img>` sources and their alt text, which name attachments the import cannot read. */
  images: { src: string; alt: string }[];
}

/**
 * Elements that start a new line.
 *
 * The document-level containers matter as much as the obvious ones. A Jira
 * "Word" export is a whole `<html><body>` document, and with those absent the
 * entire file is inline content: every heading, list and table inside is
 * rendered as one running paragraph, and the structure this module exists to
 * preserve is gone with no error to show for it.
 */
const BLOCK_TAGS = new Set([
  'html',
  'body',
  'main',
  'article',
  'section',
  'header',
  'footer',
  'aside',
  'nav',
  'figure',
  'figcaption',
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'tr',
  'hr',
  'blockquote',
  'pre',
]);

/**
 * Elements whose content is not content.
 *
 * A Word export carries its stylesheet inline, and without this the whole of it
 * would be read as the ticket's opening paragraph.
 */
const DROPPED_TAGS = new Set(['head', 'style', 'script', 'noscript', 'template', 'title', 'meta', 'link']);

/** Collapses runs of whitespace, as HTML rendering does. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ');
}

/** Escapes what would otherwise be read as Markdown structure. */
function escapeInline(value: string): string {
  return value.replace(/([\\`*_[\]])/g, '\\$1');
}

interface Context {
  anchors: HtmlAnchor[];
  images: { src: string; alt: string }[];
}

/**
 * Inline content: everything that does not start a new line.
 *
 * A block element met here is rendered as its text rather than recursed into,
 * because the only way one appears is malformed markup, and dropping it would
 * lose the words.
 */
function inline(nodes: readonly MarkupNode[], context: Context): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += escapeInline(collapse(node.value));
      continue;
    }
    if (DROPPED_TAGS.has(node.name)) continue;
    switch (node.name) {
      case 'br':
        out += '\n';
        break;
      case 'b':
      case 'strong': {
        const inner = inline(node.children, context).trim();
        out += inner ? `**${inner}**` : '';
        break;
      }
      case 'i':
      case 'em': {
        const inner = inline(node.children, context).trim();
        out += inner ? `*${inner}*` : '';
        break;
      }
      case 'tt':
      case 'code':
      case 'kbd': {
        const inner = collapse(textOf(node)).trim();
        out += inner ? `\`${inner}\`` : '';
        break;
      }
      case 'img': {
        const src = node.attrs['src'] ?? '';
        const alt = node.attrs['alt'] ?? '';
        context.images.push({ src, alt });
        // The alt text of a Jira image is the attachment's filename, which is
        // the only part of it this import can actually resolve.
        out += `![${escapeInline(alt)}](${src})`;
        break;
      }
      case 'a': {
        const inner = inline(node.children, context).trim();
        const href = node.attrs['href'];
        if (!inner) break;
        out += href ? `[${inner}](${href})` : inner;
        break;
      }
      default:
        out += inline(node.children, context);
    }
  }
  return out;
}

function cellText(cell: MarkupElement, context: Context): string {
  // A cell may hold a whole list -- Confluence wraps the "Given" column in
  // `<ol>` -- so render its blocks and then flatten to one line, because a
  // Markdown cell cannot contain a line break.
  const rendered = blocks([cell], context).trim();
  return rendered.replace(/\s*\n\s*/g, ' ').replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
}

interface TableRow {
  cells: string[];
  header: boolean;
}

function readTable(table: MarkupElement, context: Context): string {
  const rows: TableRow[] = [];
  for (const tr of findAll(table, 'tr')) {
    const cells: string[] = [];
    let header = false;
    for (const cell of tr.children) {
      if (!isElement(cell)) continue;
      if (cell.name !== 'td' && cell.name !== 'th') continue;
      if (cell.name === 'th') header = true;
      cells.push(cellText(cell, context));
    }
    if (cells.length > 0) rows.push({ cells, header });
  }
  if (rows.length === 0) return '';

  const first = rows[0];
  if (!first) return '';
  const width = first.cells.length;

  const normalise = (row: TableRow): string[] => {
    if (row.cells.length <= width) {
      return [...row.cells, ...Array<string>(width - row.cells.length).fill('')];
    }
    // More cells than columns: the surplus came from a separator character
    // inside the author's text. Put it back rather than dropping the tail.
    const kept = row.cells.slice(0, width - 1);
    kept.push(row.cells.slice(width - 1).join(CELL_SEPARATOR));
    return kept;
  };

  const escapeCell = (value: string): string => value.replace(/\|/g, '\\|');
  const line = (cells: string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`;

  const [head, ...rest] = rows;
  const body = head?.header ? rest : rows;
  const heading = head?.header ? normalise(head) : Array<string>(width).fill('');

  const out = [line(heading), `| ${Array<string>(width).fill('---').join(' | ')} |`];
  for (const row of body) out.push(line(normalise(row)));
  return out.join('\n');
}

const LIST_MARKER = /^\s*(?:[-*]|\d+\.)\s/;

/**
 * Renders a list.
 *
 * Indentation is added here, by the item that owns the nested content, rather
 * than by the nested list itself -- otherwise each level is indented twice.
 * The blank line `blocks` puts between an item's text and a list beneath it is
 * dropped for the same kind of reason: in Markdown that blank line ends the
 * list rather than continuing it.
 */
function list(node: MarkupElement, context: Context, ordered: boolean): string {
  const out: string[] = [];
  let index = 1;

  for (const item of node.children) {
    if (!isElement(item) || item.name !== 'li') continue;

    const marker = ordered ? `${index}.` : '-';
    index += 1;

    const rendered = blocks(item.children, context).trim();
    if (!rendered) continue;

    const lines = rendered
      .split('\n')
      .filter((line, at, all) => line !== '' || !LIST_MARKER.test(all[at + 1] ?? ''));

    const [firstLine = '', ...more] = lines;
    out.push(`${marker} ${firstLine}`);
    for (const extra of more) out.push(extra ? `  ${extra}` : '');
  }

  return out.join('\n');
}

/** Block-level content: each entry becomes its own paragraph or structure. */
function blocks(nodes: readonly MarkupNode[], context: Context): string {
  const out: string[] = [];
  let pending: MarkupNode[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const rendered = inline(pending, context).trim();
    pending = [];
    if (rendered) out.push(rendered);
  };

  for (const node of nodes) {
    if (node.type === 'element' && DROPPED_TAGS.has(node.name)) continue;
    if (node.type === 'text' || !BLOCK_TAGS.has(node.name)) {
      pending.push(node);
      continue;
    }
    flush();

    switch (node.name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number.parseInt(node.name.slice(1), 10);
        // Confluence emits `<h2><a name="Anchor"></a>Heading</h2>`; the anchor
        // is a stable id for the section, better than a slug of the text.
        const anchor = node.children.find(
          (child): child is MarkupElement =>
            isElement(child) && child.name === 'a' && typeof child.attrs['name'] === 'string',
        );
        const heading = inline(node.children, context).trim();
        if (anchor) {
          const name = anchor.attrs['name'];
          if (name) context.anchors.push({ name, heading, level });
        }
        if (heading) out.push(`${'#'.repeat(Math.min(level, 6))} ${heading}`);
        break;
      }
      case 'hr':
        out.push('---');
        break;
      case 'ul':
      case 'ol': {
        const rendered = list(node, context, node.name === 'ol');
        if (rendered) out.push(rendered);
        break;
      }
      case 'table': {
        const rendered = readTable(node, context);
        if (rendered) out.push(rendered);
        break;
      }
      case 'pre': {
        const body = textOf(node).replace(/\s+$/, '');
        if (body) out.push(`\`\`\`\n${body}\n\`\`\``);
        break;
      }
      case 'blockquote': {
        const rendered = blocks(node.children, context).trim();
        if (rendered) {
          out.push(
            rendered
              .split('\n')
              .map((row) => (row ? `> ${row}` : '>'))
              .join('\n'),
          );
        }
        break;
      }
      default: {
        // p, div, li, tr and anything else block-level: transparent containers.
        const rendered = blocks(node.children, context).trim();
        if (rendered) out.push(rendered);
      }
    }
  }
  flush();

  return out.join('\n\n');
}

/** Converts a fragment of Confluence-rendered HTML to Markdown. */
export function htmlToMarkdown(html: string): HtmlConversion {
  const context: Context = { anchors: [], images: [] };
  const root = parseMarkup(html, { voidTags: HTML_VOID_TAGS, html: true });
  const markdown = blocks(root.children, context)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, anchors: context.anchors, images: context.images };
}
