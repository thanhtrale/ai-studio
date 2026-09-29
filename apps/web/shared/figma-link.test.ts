import { describe, expect, it } from 'vitest';

import { MAX_DESIGN_LINKS, figmaLink, findFigmaLinks, readFigmaLink, readFigmaLinks } from './figma-link';

const KEY = 'AbCdEf123456GhIjKl';
const OTHER = 'ZzYyXx987654WwVvUu';

function link(nodeId: string, key = KEY): string {
  return `https://www.figma.com/design/${key}/Capella-Revamp---WF?node-id=${nodeId}&m=dev`;
}

describe('readFigmaLink', () => {
  it('reads a design link, normalising the node id to the form the tools take', () => {
    const reading = readFigmaLink('https://www.figma.com/design/AbCdEf123456/Capella-Web?node-id=123-456&t=xyz');
    expect(reading).toEqual({
      ok: true,
      reference: { fileKey: 'AbCdEf123456', nodeId: '123:456', fileName: 'Capella Web' },
    });
  });

  it('accepts the colon form, encoded or not', () => {
    for (const spelling of ['123-456', '123%3A456', '123:456']) {
      const reading = readFigmaLink(`https://www.figma.com/file/AbCdEf123456/x?node-id=${spelling}`);
      expect(reading.ok && reading.reference.nodeId).toBe('123:456');
    }
  });

  it('accepts a link pasted without its scheme, which is the same link', () => {
    const reading = readFigmaLink('www.figma.com/design/AbCdEf123456/x?node-id=1-2');
    expect(reading.ok && reading.reference.fileKey).toBe('AbCdEf123456');
  });

  it('says what is wrong rather than that something is', () => {
    expect(readFigmaLink('https://www.figma.com/design/AbCdEf123456/Capella-Web')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/names no node/),
    });
    expect(readFigmaLink('https://example.com/design/AbCdEf123456/x?node-id=1-2')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is not Figma/),
    });
    expect(readFigmaLink('https://www.figma.com/files/project/12345?node-id=1-2')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no file key/),
    });
  });

  it('round-trips through the canonical link', () => {
    const original = 'https://www.figma.com/design/AbCdEf123456/Capella-Web?node-id=123-456';
    const reading = readFigmaLink(original);
    expect(reading.ok && figmaLink(reading.reference)).toBe(original);
  });
});

describe('findFigmaLinks', () => {
  /**
   * The reported failure, in the shape it was reported in.
   *
   * An AI editor's "add to context" writes `Implement this design from Figma.
   * @<url>`, and the whole paste was handed to `new URL`, which refused it --
   * correctly, and uselessly. The link is right there in the text.
   */
  it('finds a link inside the sentence it was pasted with', () => {
    const pasted = `Implement this design from Figma. @${link('4199-3990')}`;
    expect(findFigmaLinks(pasted)).toEqual([link('4199-3990')]);
  });

  it('stops at the whitespace, the bracket and the full stop around a link', () => {
    expect(findFigmaLinks(`see ${link('1-2')}.`)).toEqual([link('1-2')]);
    expect(findFigmaLinks(`[desktop](${link('1-2')})`)).toEqual([link('1-2')]);
    expect(findFigmaLinks(`${link('1-2')}, ${link('3-4')}`)).toEqual([link('1-2'), link('3-4')]);
  });

  it('ignores figma.com mentioned without a path', () => {
    expect(findFigmaLinks('the design is on figma.com somewhere')).toEqual([]);
  });
});

describe('readFigmaLinks', () => {
  it('reads one link per line, in the order given', () => {
    const { references, problems } = readFigmaLinks(
      `desktop ${link('1-2')}\ntablet ${link('3-4')}\nmobile ${link('5-6')}`,
    );
    expect(problems).toEqual([]);
    expect(references.map((reference) => reference.nodeId)).toEqual(['1:2', '3:4', '5:6']);
  });

  it('treats the same link twice as the slip it is', () => {
    const { references, problems } = readFigmaLinks(`${link('1-2')}\n${link('1-2')}`);
    expect(references).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it('names which link is wrong when there is more than one', () => {
    const { references, problems } = readFigmaLinks(
      `${link('1-2')}\nhttps://www.figma.com/design/${KEY}/x\n${link('5-6')}`,
    );
    expect(references).toHaveLength(2);
    expect(problems).toEqual([expect.stringMatching(/^the 2nd link: .*names no node/)]);
  });

  it('reads a lone bad link without numbering it', () => {
    const { problems } = readFigmaLinks(`https://www.figma.com/design/${KEY}/x`);
    expect(problems).toEqual([expect.stringMatching(/^that Figma link names no node/)]);
  });

  /**
   * The rule that keeps the evidence check honest. A node id is unique inside
   * its own file and meaningless outside it, so a citation checked against a
   * set spanning two files could verify against a frame it never came from --
   * passing while being wrong, which is worse than failing.
   */
  it('refuses links to two different files', () => {
    const { problems } = readFigmaLinks(`${link('1-2')}\n${link('3-4', OTHER)}`);
    expect(problems).toEqual([expect.stringMatching(/different Figma files/)]);
  });

  it('refuses more links than one analysis reads', () => {
    const many = Array.from({ length: MAX_DESIGN_LINKS + 1 }, (_entry, at) => link(`${at + 1}-1`));
    const { problems } = readFigmaLinks(many.join('\n'));
    expect(problems).toEqual([expect.stringMatching(new RegExp(`more than the ${MAX_DESIGN_LINKS}`))]);
  });

  it('says a paste held no link rather than calling the paste a bad URL', () => {
    const { references, problems } = readFigmaLinks('Implement the design from the ticket, please.');
    expect(references).toEqual([]);
    expect(problems).toEqual([expect.stringMatching(/no Figma link found/)]);
  });

  it('asks for a link when given nothing at all', () => {
    for (const nothing of ['', '   ', undefined, null, 42]) {
      expect(readFigmaLinks(nothing).problems).toEqual(['at least one Figma link is required']);
    }
  });
});
