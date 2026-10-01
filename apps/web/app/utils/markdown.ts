/**
 * The markdown this application writes, turned into HTML.
 *
 * Not a markdown implementation. It handles the constructs `render.ts` and
 * `authoring.ts` actually emit -- headings, lists two deep, blockquotes,
 * paragraphs, bold, italic, inline code -- and nothing else. That is the point:
 * a general parser would be a much larger surface for content that arrives from
 * a Jira ticket by way of a language model, and none of the rest is used.
 *
 * ## Why this is safe to put through `v-html`
 *
 * Every character of the source is HTML-escaped **first**. After that, no
 * sequence in the source can become a tag, because `<` is already `&lt;` before
 * a single rule runs. Every tag in the output is a literal in this file.
 *
 * There is exactly one hole in that, and it is deliberate: `<sub>` and
 * `</sub>`, which `renderRequirements` emits to tuck the evidence under a
 * requirement, are put back after escaping. They carry no attributes and no
 * content of their own, so the worst a ticket that contains the literal text
 * `<sub>` can achieve is subscripted text. Nothing else is ever unescaped.
 *
 * The alternative -- stripping the `<sub>` from `requirements.md` -- was
 * rejected because that file is also read outside this application, where the
 * tag renders and is worth having.
 */

/** The only tags allowed back after escaping, and they take no attributes. */
const KEPT_TAGS = ['sub', '/sub'] as const;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** Escapes everything, then puts back the one tag pair that is allowed. */
function escapeKeeping(value: string): string {
  let escaped = escapeHtml(value);
  for (const tag of KEPT_TAGS) {
    escaped = escaped.split(`&lt;${tag}&gt;`).join(`<${tag}>`);
  }
  return escaped;
}

/**
 * Inline marks, applied to already-escaped text.
 *
 * The text is split on code spans and only the parts outside them are marked
 * up, so `**` inside a span stays literal. The obvious alternative -- swapping
 * spans out for a placeholder and back -- needs a sentinel string that the
 * content cannot contain, and there is no such string that is also obviously
 * safe. Splitting needs none.
 */
function inline(text: string): string {
  return escapeKeeping(text)
    .split(/(`[^`]+`)/g)
    .map((part) => {
      const code = /^`([^`]+)`$/.exec(part);
      if (code) return `<code>${code[1] ?? ''}</code>`;
      return (
        part
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          // Underscores only at word boundaries, so a snake_case field name in
          // a sentence does not turn half of it into italics.
          .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>')
      );
    })
    .join('');
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

function isBlockStart(line: string): boolean {
  return !line.trim() || HEADING.test(line) || BULLET.test(line) || QUOTE.test(line);
}

/**
 * A list, two levels deep.
 *
 * Two is what the renderers produce -- a gap and the readings under it, a field
 * and its companion field -- and a general depth would need a stack for no
 * caller that exists.
 */
function renderList(lines: readonly string[]): string {
  const out: string[] = ['<ul>'];
  let nested = false;
  let open = false;

  for (const line of lines) {
    const match = BULLET.exec(line);
    if (!match) continue;
    const deep = (match[1] ?? '').length >= 2;
    const text = inline(match[2] ?? '');

    if (deep) {
      if (!nested) {
        // A nested list belongs inside the item that owns it, so the open item
        // is not closed until its children are in.
        out.push('<ul>');
        nested = true;
      }
      out.push(`<li>${text}</li>`);
      continue;
    }

    if (nested) {
      out.push('</ul>');
      nested = false;
    }
    if (open) out.push('</li>');
    out.push(`<li>${text}`);
    open = true;
  }

  if (nested) out.push('</ul>');
  if (open) out.push('</li>');
  out.push('</ul>');
  return out.join('');
}

/** Turns the markdown this application writes into HTML. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at] ?? '';

    if (!line.trim()) {
      at += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? '')) {
        quoted.push(QUOTE.exec(lines[at] ?? '')?.[1] ?? '');
        at += 1;
      }
      out.push(`<blockquote>${inline(quoted.join(' '))}</blockquote>`);
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (at < lines.length && BULLET.test(lines[at] ?? '')) {
        items.push(lines[at] ?? '');
        at += 1;
      }
      out.push(renderList(items));
      continue;
    }

    const paragraph: string[] = [];
    while (at < lines.length && !isBlockStart(lines[at] ?? '')) {
      paragraph.push(lines[at] ?? '');
      at += 1;
    }
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return out.join('');
}
