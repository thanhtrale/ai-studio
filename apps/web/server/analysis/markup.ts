/**
 * A tolerant tag tokeniser, used for both the Jira XML export and the HTML
 * inside it.
 *
 * One mechanism rather than two, because a Jira export is XML whose
 * `<description>` is entity-escaped HTML: the same document needs reading
 * twice, at two levels, and the second level is markup a browser would forgive.
 * So this forgives the same things -- unclosed elements, stray closing tags,
 * unquoted attribute values -- and never throws on input. A parser that rejects
 * a malformed ticket is a parser that rejects real tickets.
 *
 * It is deliberately not a conforming HTML parser. There is no tag-soup
 * insertion algorithm, no foster parenting, no `<table>` scope repair. What it
 * handles is the shape Confluence and Jira actually emit, which is well-formed
 * apart from the cases named above.
 */

export interface MarkupText {
  type: 'text';
  value: string;
}

export interface MarkupElement {
  type: 'element';
  /** Lowercased, so callers never have to care how the source spelled it. */
  name: string;
  attrs: Record<string, string>;
  children: MarkupNode[];
}

export type MarkupNode = MarkupText | MarkupElement;

/** HTML elements that never have a closing tag. Empty for XML. */
export const HTML_VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Elements an opening tag of the same name implicitly closes.
 *
 * `<li>a<li>b` is two items in every browser, and Jira's older wiki renderer
 * emits exactly that often enough to matter.
 */
const IMPLIED_END: ReadonlySet<string> = new Set(['li', 'p', 'td', 'th', 'tr', 'option']);

export interface ParseMarkupOptions {
  /** Tags with no closing tag. Pass `HTML_VOID_TAGS` for HTML; omit for XML. */
  voidTags?: ReadonlySet<string>;
  /** Apply the implied-end-tag rule. On for HTML, off for XML. */
  html?: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
  bull: '•',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * Resolves character references.
 *
 * Numeric references are not decoration here: a Jira export writes non-ASCII
 * display names as `&#224;`, so an assignee's name is unreadable without this.
 */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // Lone surrogates are not characters; leaving the reference intact is
      // more honest than emitting a replacement character.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && NAME_START.test(char);
}

/** Reads a tag or attribute name from `source` at `index`. */
function readName(source: string, index: number): { name: string; next: number } {
  let end = index;
  while (end < source.length) {
    const char = source[end];
    if (char === undefined || !NAME_CHAR.test(char)) break;
    end += 1;
  }
  return { name: source.slice(index, end), next: end };
}

function skipSpace(source: string, index: number): number {
  let next = index;
  while (next < source.length) {
    const char = source[next];
    if (char === undefined || !/\s/.test(char)) break;
    next += 1;
  }
  return next;
}

interface OpenTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  next: number;
}

function readOpenTag(source: string, index: number): OpenTag | null {
  const { name, next } = readName(source, index);
  if (!name) return null;

  const attrs: Record<string, string> = {};
  let cursor = skipSpace(source, next);
  let selfClosing = false;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '>') {
      cursor += 1;
      break;
    }
    if (char === '/' && source[cursor + 1] === '>') {
      selfClosing = true;
      cursor += 2;
      break;
    }
    if (!isNameStart(char)) {
      // Junk inside a tag. Step over it rather than abandoning the element.
      cursor += 1;
      continue;
    }

    const attr = readName(source, cursor);
    cursor = skipSpace(source, attr.next);
    let value = '';
    if (source[cursor] === '=') {
      cursor = skipSpace(source, cursor + 1);
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, cursor + 1);
        const stop = end === -1 ? source.length : end;
        value = source.slice(cursor + 1, stop);
        cursor = stop + 1;
      } else {
        let end = cursor;
        while (end < source.length) {
          const at = source[end];
          if (at === undefined || /[\s>]/.test(at)) break;
          end += 1;
        }
        value = source.slice(cursor, end);
        cursor = end;
      }
    }

    const key = attr.name.toLowerCase();
    // First wins, which is what a browser does with a repeated attribute --
    // and a Jira comment really does emit `rel` twice on one anchor.
    if (!(key in attrs)) attrs[key] = decodeEntities(value);
    cursor = skipSpace(source, cursor);
  }

  return { name: name.toLowerCase(), attrs, selfClosing, next: cursor };
}

/**
 * Parses markup into a tree under a synthetic `#root` element.
 *
 * Never throws: anything it cannot make sense of becomes text.
 */
export function parseMarkup(source: string, options: ParseMarkupOptions = {}): MarkupElement {
  const voidTags = options.voidTags ?? new Set<string>();
  const root: MarkupElement = { type: 'element', name: '#root', attrs: {}, children: [] };
  const stack: MarkupElement[] = [root];

  const top = (): MarkupElement => stack[stack.length - 1] ?? root;

  const pushText = (raw: string, decode = true): void => {
    if (!raw) return;
    const parent = top();
    const value = decode ? decodeEntities(raw) : raw;
    const last = parent.children[parent.children.length - 1];
    // Merge adjacent text, so a CDATA section or an entity never splits a word
    // into nodes a caller then has to rejoin.
    if (last && last.type === 'text') last.value += value;
    else parent.children.push({ type: 'text', value });
  };

  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open === -1) {
      pushText(source.slice(cursor));
      break;
    }
    pushText(source.slice(cursor, open));

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      const stop = end === -1 ? source.length : end;
      pushText(source.slice(open + 9, stop), false);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', open)) {
      const end = source.indexOf('>', open + 2);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }

    if (source[open + 1] === '/') {
      const { name, next } = readName(source, open + 2);
      const end = source.indexOf('>', next);
      cursor = end === -1 ? source.length : end + 1;
      const wanted = name.toLowerCase();
      // Pop to the nearest matching open element. A close with nothing open to
      // match is stray markup, and is ignored rather than unwinding the tree.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.name === wanted) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    if (!isNameStart(source[open + 1])) {
      // A bare `<` in text, which Jira descriptions do contain.
      pushText('<');
      cursor = open + 1;
      continue;
    }

    const tag = readOpenTag(source, open + 1);
    if (!tag) {
      pushText('<');
      cursor = open + 1;
      continue;
    }

    if (options.html && IMPLIED_END.has(tag.name) && top().name === tag.name) {
      stack.pop();
    }

    const element: MarkupElement = {
      type: 'element',
      name: tag.name,
      attrs: tag.attrs,
      children: [],
    };
    top().children.push(element);
    if (!tag.selfClosing && !voidTags.has(tag.name)) stack.push(element);
    cursor = tag.next;
  }

  return root;
}

export function isElement(node: MarkupNode): node is MarkupElement {
  return node.type === 'element';
}

/** Direct children with this tag name. */
export function childrenNamed(parent: MarkupElement, name: string): MarkupElement[] {
  return parent.children.filter((node): node is MarkupElement => isElement(node) && node.name === name);
}

/** The first descendant with this tag name, depth first. */
export function find(parent: MarkupElement, name: string): MarkupElement | null {
  for (const node of parent.children) {
    if (!isElement(node)) continue;
    if (node.name === name) return node;
    const nested = find(node, name);
    if (nested) return nested;
  }
  return null;
}

/** Every descendant with this tag name, in document order. */
export function findAll(parent: MarkupElement, name: string): MarkupElement[] {
  const found: MarkupElement[] = [];
  for (const node of parent.children) {
    if (!isElement(node)) continue;
    if (node.name === name) found.push(node);
    found.push(...findAll(node, name));
  }
  return found;
}

/** All text beneath a node, concatenated. */
export function textOf(node: MarkupNode): string {
  if (node.type === 'text') return node.value;
  return node.children.map(textOf).join('');
}

/** The text of the first descendant with this name, trimmed; empty when absent. */
export function textOfChild(parent: MarkupElement, name: string): string {
  const node = find(parent, name);
  return node ? textOf(node).trim() : '';
}
