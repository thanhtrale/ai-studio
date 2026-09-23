import { describe, expect, it } from 'vitest';

import { htmlToMarkdown } from './html-to-markdown';
import { HTML_VOID_TAGS, decodeEntities, find, findAll, parseMarkup, textOf } from './markup';

describe('decodeEntities', () => {
  it('resolves named references', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')).toBe('<a> & "b" \'c\'');
  });

  it('resolves numeric references, which is how Jira writes non-ASCII names', () => {
    expect(decodeEntities('L&#234; V&#259;n A')).toBe('Lê Văn A');
    expect(decodeEntities('&#x1F600;')).toBe('\u{1F600}');
  });

  it('leaves an unknown or malformed reference alone rather than guessing', () => {
    expect(decodeEntities('&notareference; &#999999999;')).toBe('&notareference; &#999999999;');
  });

  it('leaves a lone surrogate intact instead of emitting a replacement', () => {
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
  });
});

describe('parseMarkup', () => {
  it('reads attributes in every quoting style', () => {
    const root = parseMarkup(`<a href="one" title='two' rel=three>x</a>`);
    const anchor = find(root, 'a');
    expect(anchor?.attrs).toEqual({ href: 'one', title: 'two', rel: 'three' });
  });

  it('takes the first of a repeated attribute, as a browser does', () => {
    // A Jira comment really does emit `rel` twice on one anchor.
    const root = parseMarkup(`<a rel="account" rel="noreferrer">x</a>`);
    expect(find(root, 'a')?.attrs['rel']).toBe('account');
  });

  it('tolerates a tag left open', () => {
    const root = parseMarkup('<div><p>one<p>two</div>', { voidTags: HTML_VOID_TAGS, html: true });
    expect(findAll(root, 'p')).toHaveLength(2);
    expect(textOf(root)).toBe('onetwo');
  });

  it('ignores a closing tag with nothing open to match', () => {
    const root = parseMarkup('<p>one</span>two</p>', { voidTags: HTML_VOID_TAGS, html: true });
    expect(textOf(root)).toBe('onetwo');
    expect(findAll(root, 'p')).toHaveLength(1);
  });

  it('treats a bare angle bracket in text as text', () => {
    expect(textOf(parseMarkup('<p>a < b</p>', { voidTags: HTML_VOID_TAGS, html: true }))).toBe('a < b');
  });

  it('skips comments, declarations and processing instructions', () => {
    const root = parseMarkup('<!-- note --><?pi?><!DOCTYPE x><item>kept</item>');
    expect(textOf(root)).toBe('kept');
    expect(find(root, 'item')).not.toBeNull();
  });

  it('does not decode a CDATA section', () => {
    expect(textOf(parseMarkup('<x><![CDATA[a &amp; b]]></x>'))).toBe('a &amp; b');
  });

  it('closes void elements without a closing tag', () => {
    const root = parseMarkup('<p>a<br>b<img src="x">c</p>', { voidTags: HTML_VOID_TAGS, html: true });
    expect(find(root, 'p')?.children.filter((node) => node.type === 'element')).toHaveLength(2);
  });

  it('never throws on truncated input', () => {
    for (const bad of ['<', '<a href="', '<!-- unterminated', '</>', '<a', '<![CDATA[']) {
      expect(() => parseMarkup(bad, { voidTags: HTML_VOID_TAGS, html: true })).not.toThrow();
    }
  });
});

describe('htmlToMarkdown', () => {
  it('keeps headings, and reports the anchor before each', () => {
    const { markdown, anchors } = htmlToMarkdown('<h2><a name="AcceptanceCriteria"></a>Acceptance</h2>');
    expect(markdown).toBe('## Acceptance');
    expect(anchors).toEqual([{ name: 'AcceptanceCriteria', heading: 'Acceptance', level: 2 }]);
  });

  it('keeps a list a list, with nesting', () => {
    const { markdown } = htmlToMarkdown('<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>');
    expect(markdown).toBe('- one\n  - deep\n- two');
  });

  it('numbers an ordered list', () => {
    expect(htmlToMarkdown('<ol><li>a</li><li>b</li></ol>').markdown).toBe('1. a\n2. b');
  });

  it('renders a table with its header', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(markdown).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('rejoins a row that has more cells than the header has columns', () => {
    // The surplus cell came from a separator character inside the author's
    // text, so putting it back is the inverse of the split -- not a repair
    // that invents anything.
    const { markdown } = htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>before (</td><td>) after</td></tr></table>',
    );
    expect(markdown).toContain('| 1 | before (\\|) after |');
  });

  it('pads a row that has too few cells', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>',
    );
    expect(markdown).toContain('| 1 |  |');
  });

  it('flattens a list inside a table cell, because a cell cannot hold a line break', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tr><th>Given</th></tr><tr><td><ol><li>Desktop Layout</li></ol></td></tr></table>',
    );
    expect(markdown).toContain('| Desktop Layout |');
  });

  it('records images without resolving them', () => {
    const { markdown, images } = htmlToMarkdown('<img src="https://x/attachment/1" alt="shot.png">');
    expect(images).toEqual([{ src: 'https://x/attachment/1', alt: 'shot.png' }]);
    expect(markdown).toBe('![shot.png](https://x/attachment/1)');
  });

  it('escapes text that would otherwise read as structure', () => {
    expect(htmlToMarkdown('<p>a_b and *c* and [d]</p>').markdown).toBe('a\\_b and \\*c\\* and \\[d\\]');
  });

  it('keeps structure inside a whole document, which is what a Word export is', () => {
    // Without html and body counting as blocks, the entire export renders as
    // one running paragraph: every heading, list and table inside is gone,
    // with no error to show for it.
    const { markdown } = htmlToMarkdown(
      '<html><body><h1>[CAP-59] Card</h1><ul><li>one</li></ul></body></html>',
    );
    expect(markdown).toBe('# \\[CAP-59\\] Card\n\n- one');
  });

  it('drops a stylesheet rather than reading it as the opening paragraph', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head><style>.x{color:red}</style><title>t</title></head><body><p>Body.</p></body></html>',
    );
    expect(markdown).toBe('Body.');
  });

  it('drops an empty anchor without losing its siblings', () => {
    expect(htmlToMarkdown('<p><a name="x"></a>text</p>').markdown).toBe('text');
  });
});
