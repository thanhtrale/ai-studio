import { describe, expect, it } from 'vitest';

import { RelayError } from '../../utils/supervisor';
import type { DesignNode } from './digest';
import { buildDigest, describeDigest } from './digest';
import { figmaLink, parseFigmaLink } from './link';

describe('parseFigmaLink', () => {
  it('reads a design link, normalising the node id to the form the tools take', () => {
    const reference = parseFigmaLink(
      'https://www.figma.com/design/AbCdEf123456/Capella-Web?node-id=123-456&t=xyz',
    );
    expect(reference).toEqual({ fileKey: 'AbCdEf123456', nodeId: '123:456', fileName: 'Capella Web' });
  });

  it('accepts the colon form, encoded or not', () => {
    expect(parseFigmaLink('https://www.figma.com/file/AbCdEf123456/x?node-id=123%3A456').nodeId).toBe(
      '123:456',
    );
    expect(parseFigmaLink('https://www.figma.com/design/AbCdEf123456/x?node-id=123:456').nodeId).toBe(
      '123:456',
    );
  });

  it('accepts the other surfaces a file key can sit behind', () => {
    for (const segment of ['design', 'file', 'proto', 'board', 'slides']) {
      expect(
        parseFigmaLink(`https://www.figma.com/${segment}/AbCdEf123456/x?node-id=1-2`).fileKey,
      ).toBe('AbCdEf123456');
    }
  });

  it('refuses a link with no node, because a whole file is not a block', () => {
    expect(() => parseFigmaLink('https://www.figma.com/design/AbCdEf123456/Capella-Web')).toThrow(
      /names no node/,
    );
  });

  it('refuses a link that is not Figma', () => {
    expect(() => parseFigmaLink('https://example.com/design/AbCdEf123456/x?node-id=1-2')).toThrow(
      /is not Figma/,
    );
  });

  it('refuses a project link, which carries no file key', () => {
    expect(() => parseFigmaLink('https://www.figma.com/files/project/12345?node-id=1-2')).toThrow(
      /no file key/,
    );
  });

  it('refuses anything that is not a URL at all', () => {
    for (const bad of ['', '   ', 'node-id=1-2', undefined, 42]) {
      expect(() => parseFigmaLink(bad)).toThrow(RelayError);
    }
  });

  it('round-trips through the canonical link', () => {
    const original = 'https://www.figma.com/design/AbCdEf123456/Capella-Web?node-id=123-456';
    expect(figmaLink(parseFigmaLink(original))).toBe(original);
  });
});

/** A small tree carrying one of each thing the digest is supposed to notice. */
function tree(): DesignNode {
  return {
    id: '1:1',
    name: 'Featured Story Card',
    type: 'FRAME',
    width: 1440,
    height: 720,
    layout: 'HORIZONTAL',
    spacing: 64,
    children: [
      {
        id: '1:2',
        name: 'Hero',
        type: 'RECTANGLE',
        width: 704,
        height: 720,
        hasImageFill: true,
      },
      {
        id: '1:3',
        name: 'Copy',
        type: 'FRAME',
        layout: 'VERTICAL',
        spacing: 24,
        children: [
          { id: '1:4', name: 'Eyebrow', type: 'TEXT', text: 'SENTOSA' },
          {
            id: '1:5',
            name: 'Headline',
            type: 'TEXT',
            text: 'UNVEIL JUNGLE BETWEEN SKY AND SEA',
            width: 640,
            height: 72,
          },
          { id: '1:6', name: 'Hidden note', type: 'TEXT', text: 'do not ship', visible: false },
          {
            id: '1:7',
            name: 'Arrow',
            type: 'INSTANCE',
            component: 'icon/arrow',
            variant: 'direction=right',
            children: [
              { id: '1:8', name: 'stroke', type: 'VECTOR' },
              { id: '1:9', name: 'head', type: 'VECTOR' },
            ],
          },
        ],
      },
    ],
  };
}

describe('buildDigest', () => {
  const result = buildDigest(tree());

  it('keeps what a requirement can be written from', () => {
    expect(result.digest).toContain('#1:5 TEXT "Headline" 640x72 text:"UNVEIL JUNGLE BETWEEN SKY AND SEA"');
    expect(result.digest).toContain('image-fill');
    expect(result.digest).toContain('HORIZONTAL/gap:64');
    expect(result.digest).toContain('of:"icon/arrow" variant:"direction=right"');
  });

  it('indents to show the hierarchy', () => {
    const lines = result.digest.split('\n');
    expect(lines[0]?.startsWith('#1:1')).toBe(true);
    expect(lines.find((entry) => entry.includes('#1:4'))?.startsWith('    ')).toBe(true);
  });

  it('drops a hidden node and the geometry inside an icon, and says how many', () => {
    expect(result.digest).not.toContain('do not ship');
    expect(result.digest).not.toContain('#1:8');
    // The icon itself survives; the two paths that draw it do not.
    expect(result.digest).toContain('#1:7');
    expect(result.droppedNodes).toBe(3);
  });

  it('keeps every id it mentions, and mentions every id it keeps', () => {
    for (const id of result.nodeIds) expect(result.digest).toContain(`#${id}`);
    const mentioned = [...result.digest.matchAll(/#(\d+:\d+)/g)].map((match) => match[1]);
    expect(mentioned).toEqual(result.nodeIds);
  });

  it('is deterministic', () => {
    expect(buildDigest(tree())).toEqual(buildDigest(tree()));
  });

  it('cuts by depth rather than mid-tree when it will not fit', () => {
    const cut = buildDigest(tree(), { maxNodes: 3 });
    // A shallower picture is coherent; half a tree is wrong about what the
    // block contains.
    expect(cut.truncatedAtDepth).toBe(1);
    expect(cut.digest).toContain('#1:3');
    expect(cut.digest).not.toContain('#1:4');
    expect(cut.nodeIds).toEqual(['1:1', '1:2', '1:3']);
  });

  it('respects a character budget as well as a node budget', () => {
    const cut = buildDigest(tree(), { maxChars: 120 });
    expect(cut.truncatedAtDepth).toBeDefined();
    expect(cut.digest.length).toBeLessThanOrEqual(120);
  });

  it('shortens a long text sample at a word boundary', () => {
    const long = buildDigest({
      id: '2:1',
      name: 'Body',
      type: 'TEXT',
      text: 'word '.repeat(60),
    });
    expect(long.digest).toContain('…');
    expect(long.digest).not.toContain('wor…');
  });

  it('returns nothing for a tree that is entirely invisible', () => {
    const empty = buildDigest({ id: '3:1', name: 'Hidden', type: 'FRAME', visible: false });
    expect(empty.digest).toBe('');
    expect(empty.nodeIds).toEqual([]);
    expect(empty.droppedNodes).toBe(1);
  });
});

describe('describeDigest', () => {
  it('says what the reduction did', () => {
    expect(describeDigest(buildDigest(tree()))).toBe('6 nodes · 3 dropped');
    expect(describeDigest(buildDigest(tree(), { maxNodes: 3 }))).toBe(
      '3 nodes · 3 dropped · cut at depth 1',
    );
  });
});
