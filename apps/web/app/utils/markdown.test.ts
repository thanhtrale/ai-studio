import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown } from './markdown';

describe('escapeHtml', () => {
  it('neutralises every character that could open a tag or an attribute', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });
});

describe('renderMarkdown', () => {
  it('renders the headings, lists and quotes the reports are written in', () => {
    const html = renderMarkdown(
      ['# Block', '', '> The design is the source of truth.', '', '## Requirements', '', '- one', '- two'].join('\n'),
    );
    expect(html).toContain('<h1>Block</h1>');
    expect(html).toContain('<blockquote>The design is the source of truth.</blockquote>');
    expect(html).toContain('<h2>Requirements</h2>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
  });

  it('nests a sub-list inside the item that owns it', () => {
    const html = renderMarkdown(['- The gap', '  - Design: a still image', '  - Ticket: video', '- Another'].join('\n'));
    // The children belong to the first item, not beside it -- a flat render
    // would read as five unrelated statements rather than one gap and its two
    // readings.
    expect(html).toBe(
      '<ul><li>The gap<ul><li>Design: a still image</li><li>Ticket: video</li></ul></li><li>Another</li></ul>',
    );
  });

  it('marks bold, italic and code', () => {
    expect(renderMarkdown('**bold** and _soft_ and `code`')).toBe(
      '<p><strong>bold</strong> and <em>soft</em> and <code>code</code></p>',
    );
  });

  it('leaves a snake_case name alone, which an underscore rule usually eats', () => {
    expect(renderMarkdown('The field classes_alignment is a variant.')).toBe(
      '<p>The field classes_alignment is a variant.</p>',
    );
  });

  it('does not read markup inside a code span', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('joins the lines of one paragraph rather than breaking mid-sentence', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one two</p>');
  });

  /**
   * The property the whole file rests on. Ticket text reaches this by way of a
   * language model, so nothing in the source may become a tag.
   */
  it('cannot be made to emit a tag from its source', () => {
    const hostile = [
      '# <script>alert(1)</script>',
      '',
      '- <img src=x onerror=alert(1)>',
      '- <a href="javascript:alert(1)">click</a>',
      '',
      '<iframe src="http://evil"></iframe>',
    ].join('\n');

    const html = renderMarkdown(hostile);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps the one tag the requirement document actually uses', () => {
    // `<sub>` is how the evidence is tucked under a requirement, and that file
    // is read outside this application too.
    expect(renderMarkdown('- It is one field. <sub>`#1:2`</sub>')).toBe(
      '<ul><li>It is one field. <sub><code>#1:2</code></sub></li></ul>',
    );
  });

  it('lets no other tag back through, however it is spelled', () => {
    expect(renderMarkdown('<subs onload=1>')).not.toContain('<subs');
    expect(renderMarkdown('<sub class="x">')).not.toContain('<sub class');
  });
});
