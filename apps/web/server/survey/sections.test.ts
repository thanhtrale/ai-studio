import { describe, expect, it } from 'vitest';

import { ueModelFor } from '#shared/ue-model';

import type { DesignNode } from '../analysis/design/digest';
import { parseFigmaMetadata } from '../analysis/design/figma-metadata';

import { sectionsOf } from './sections';

/** A screen as Figma outlines one: a frame wrapping a stack of bands. */
const SCREEN = `
<frame id="1:1" name="Homepage" width="1440" height="4000">
  <frame id="1:2" name="Content" width="1440" height="4000">
    <instance id="2:1" name="Header/Global" componentName="Header/Global" y="0" width="1440" height="96" />
    <frame id="3:1" name="Hero" y="96" width="1440" height="720">
      <rectangle id="3:2" name="Backdrop" width="1440" height="720" fills="IMAGE" />
      <text id="3:3" name="Eyebrow" characters="SENTOSA" width="200" height="20" />
      <text id="3:4" name="Headline" characters="Wellness with new eyes" width="800" height="72" />
      <text id="3:5" name="Book CTA" characters="Book your stay" width="160" height="40" />
    </frame>
    <frame id="4:1" name="Listing" y="816" width="1440" height="1200">
      <instance id="4:2" name="Card/Article" componentName="Card/Article" width="400" height="500">
        <text id="4:3" name="Title" characters="A getaway to local culture" width="360" height="48" />
      </instance>
      <instance id="4:4" name="Card/Article" componentName="Card/Article" width="400" height="500" />
    </frame>
    <rectangle id="5:1" name="Divider" y="2016" width="1440" height="2" />
  </frame>
</frame>
`;

function tree(): DesignNode {
  const parsed = parseFigmaMetadata(SCREEN);
  if (!parsed) throw new Error('the fixture did not parse');
  return parsed;
}

const CONTEXT = {
  fileKey: 'AbCdEf123456',
  idForComponent: (name: string) => (name === 'Card/Article' ? 'card-article' : undefined),
};

describe('sectionsOf', () => {
  it('descends through a wrapper rather than reporting it as the only band', () => {
    // "Content" fills the frame and holds everything; it is the page wearing a
    // coat, not a section of it.
    const sections = sectionsOf(tree(), CONTEXT);
    expect(sections.map((section) => section.name)).toEqual(['Header/Global', 'Hero', 'Listing']);
  });

  it('orders the bands the way the page is read', () => {
    expect(sectionsOf(tree(), CONTEXT).map((section) => section.order)).toEqual([0, 1, 2]);
  });

  it('leaves out what is too short to be a band', () => {
    expect(sectionsOf(tree(), CONTEXT).map((section) => section.name)).not.toContain('Divider');
  });

  it('says when a whole band is already one component', () => {
    const [header] = sectionsOf(tree(), CONTEXT);
    expect(header?.componentName).toBe('Header/Global');
  });

  it('reads the content slots out of a band', () => {
    const hero = sectionsOf(tree(), CONTEXT)[1];
    const names = hero?.fields.map((field) => field.name);

    expect(names).toContain('Headline');
    expect(names).toContain('Eyebrow');
    expect(hero?.fields.find((field) => field.name === 'Headline')?.sample).toBe(
      'Wellness with new eyes',
    );
    // A layer named like a control is a link, not a caption.
    expect(hero?.fields.find((field) => field.name === 'Book CTA')?.kind).toBe('link');
    expect(hero?.fields.find((field) => field.name === 'Backdrop')?.kind).toBe('image');
  });

  it('counts the assets a band needs', () => {
    const hero = sectionsOf(tree(), CONTEXT)[1];
    expect(hero?.assets.map((asset) => asset.name)).toEqual(['Backdrop']);
    expect(hero?.assets[0]?.url).toContain('node-id=3-2');
  });

  it('reports work no component covers, and only that', () => {
    const sections = sectionsOf(tree(), CONTEXT);
    const hero = sections[1];
    const listing = sections[2];

    // Every layer in the hero is drawn on the page: all of it is work.
    expect(hero?.orphans.map((orphan) => orphan.name)).toEqual([
      'Backdrop',
      'Eyebrow',
      'Headline',
      'Book CTA',
    ]);
    // The listing is built from instances, so nothing in it is loose.
    expect(listing?.orphans).toEqual([]);
    expect(listing?.componentIds).toEqual(['card-article']);
  });

  it('marks a slot that repeats', () => {
    const listing = sectionsOf(tree(), CONTEXT)[2];
    // Two sibling instances share a name, so the card is a list.
    expect(listing?.fields.find((field) => field.componentName === 'Card/Article')?.repeated).toBe(true);
  });
});

describe('ueModelFor', () => {
  it('turns the slots into a block model an author can be given', () => {
    const hero = sectionsOf(tree(), CONTEXT)[1];
    if (!hero) throw new Error('no hero');

    const model = ueModelFor(hero);
    const fields = model.models[0]?.fields ?? [];

    expect(model.definitions[0]?.id).toBe('hero');
    expect(model.models[0]?.id).toBe('hero');

    const byName = new Map(fields.map((field) => [field.name, field]));
    expect(byName.get('headline')?.component).toBe('text');
    // An image is two boxes: the reference, and the alt text that must go with it.
    expect(byName.get('backdrop')?.component).toBe('reference');
    expect(byName.get('backdropAlt')?.component).toBe('text');
    // A link is the target and the words on it.
    expect(byName.get('bookCta')?.component).toBe('aem-content');
    expect(byName.get('bookCtaText')?.component).toBe('text');
  });

  it('names the block after the component when the band is one', () => {
    const header = sectionsOf(tree(), CONTEXT)[0];
    if (!header) throw new Error('no header');
    expect(ueModelFor(header).models[0]?.id).toBe('header-global');
  });
});
