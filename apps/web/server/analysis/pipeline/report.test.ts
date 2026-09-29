import { describe, expect, it } from 'vitest';

import type { Gap, NormalisedTicket, UeBlockModel } from '#shared/analysis';

import { renderAuthoringGuide } from './authoring';
import { renderGaps } from './render';

const TICKET: NormalisedTicket = {
  format: 'jira-xml',
  key: 'CAP-59',
  summary: 'Featured Story Card',
  description: 'body',
  passages: [{ id: 'p1', heading: 'Acceptance Criteria', body: '- one' }],
  comments: [{ id: '1', body: 'video autoplay is supported' }],
  attachments: [],
};

const GAPS: Gap[] = [
  {
    id: 'g1',
    kind: 'contradiction',
    statement: 'Media type disagrees.',
    designReading: 'The hero is a still image.',
    ticketReading: 'A comment says video autoplay is supported.',
    evidence: { nodeIds: ['1:2'], passageIds: ['c1'] },
    question: 'Does the hero accept video, or only images?',
  },
  {
    id: 'g2',
    kind: 'ambiguous',
    statement: 'The headline has no truncation rule.',
    evidence: { nodeIds: [], passageIds: ['p1'] },
    question: 'What happens to a headline longer than two lines?',
  },
];

describe('renderGaps', () => {
  const markdown = renderGaps({
    record: { blockName: 'featured-story-card' },
    ticket: TICKET,
    gaps: GAPS,
    inferences: [{ id: 'r2', statement: 'It fades in.', reason: 'no evidence' }],
  });

  it('is a worklist: a heading per gap, the question last', () => {
    expect(markdown).toContain('# featured-story-card — open questions (2)');
    expect(markdown).toContain('### Media type disagrees.');
    expect(markdown).toContain('- **The design shows:** The hero is a still image.');
    expect(markdown).toContain('- **The ticket claims:** A comment says video autoplay is supported.');
    expect(markdown).toContain('- **Ask:** Does the hero accept video, or only images?');
  });

  it('puts the disagreements before the vagueness', () => {
    expect(markdown.indexOf('Contradictions')).toBeLessThan(markdown.indexOf('Undetermined'));
  });

  it('cites a passage by its heading, which is what a reader recognises', () => {
    // `p1` is an ordinal so that a model can copy it exactly. Nobody wants to
    // read it.
    expect(markdown).toContain('*Acceptance Criteria*');
    expect(markdown).not.toContain('`p1`');
  });

  it('keeps the unsupported statements, and says they are not questions', () => {
    expect(markdown).toContain('## Unsupported statements (1)');
    expect(markdown).toContain('It fades in.');
  });

  it('is suspicious of a ticket that left nothing open', () => {
    const empty = renderGaps({
      record: { blockName: 'x' },
      ticket: TICKET,
      gaps: [],
      inferences: [],
    });
    expect(empty).toContain('worth being suspicious about');
  });
});

const BLOCK_DEFINITION = {
  title: 'Featured Story Card',
  id: 'featured-story-card',
  plugins: {
    xwalk: {
      page: {
        resourceType: 'core/franklin/components/block/v1/block',
        template: { model: 'featured-story-card' },
      },
    },
  },
};

function guide(model: Partial<UeBlockModel>): string {
  return renderAuthoringGuide({ definitions: [], models: [], filters: [], ...model }, 'featured-story-card');
}

describe('renderAuthoringGuide', () => {
  it('says what each field asks for, in the terms an author thinks in', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [
        {
          id: 'featured-story-card',
          fields: [
            { component: 'text', name: 'headline', label: 'Headline' },
            { component: 'richtext', name: 'body', label: 'Body' },
          ],
        },
      ],
    });

    expect(markdown).toContain('**One instance, one set of fields.**');
    expect(markdown).toContain('- **Headline** — `headline`');
    expect(markdown).toContain('A single line of plain text.');
    expect(markdown).toContain('Formatted text — bold, links, lists.');
  });

  it('folds a companion field under the one it belongs to', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [
        {
          id: 'featured-story-card',
          fields: [
            { component: 'reference', name: 'image', label: 'Hero image' },
            { component: 'text', name: 'imageAlt', label: 'Hero image alt text' },
          ],
        },
      ],
    });

    // An author sees one control. Listing the alt text as a field of its own
    // would be true and would teach the wrong thing.
    expect(markdown).toContain('- **Hero image** — `image`');
    expect(markdown).toContain('second field, `imageAlt`');
    expect(markdown).not.toContain('- **Hero image alt text** — `imageAlt`');
  });

  it('separates the variants, and says they are not content', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [
        {
          id: 'featured-story-card',
          fields: [
            { component: 'text', name: 'headline', label: 'Headline' },
            {
              component: 'select',
              name: 'classes',
              label: 'Alignment',
              options: [
                { name: 'Left', value: 'align-left' },
                { name: 'Right', value: 'align-right' },
              ],
            },
          ],
        },
      ],
    });

    expect(markdown).toContain('**Visual variants.**');
    expect(markdown).toContain('reach the block as CSS classes');
    expect(markdown).toContain('Choices: Left (`align-left`), Right (`align-right`).');
  });

  it('says so when the block repeats, and what may go inside it', () => {
    const markdown = guide({
      definitions: [
        BLOCK_DEFINITION,
        {
          title: 'Card',
          id: 'card',
          plugins: {
            xwalk: {
              page: {
                resourceType: 'core/franklin/components/block/v1/block/item',
                template: { model: 'card' },
              },
            },
          },
        },
      ],
      models: [
        { id: 'featured-story-card', fields: [{ component: 'text', name: 'title', label: 'Title' }] },
        { id: 'card', fields: [{ component: 'text', name: 'headline', label: 'Headline' }] },
      ],
      filters: [{ id: 'featured-story-card', components: ['card'] }],
    });

    expect(markdown).toContain('**This block repeats.**');
    expect(markdown).toContain('Inside `featured-story-card`: `card`');
  });
});

/**
 * The section that earns the guide its place.
 *
 * Every one of these parses cleanly, so no validator anywhere else in the
 * pipeline would mention them -- and the first was produced by both arms on the
 * first real run of the feature.
 */
describe('renderAuthoringGuide, on what pass 4 got wrong', () => {
  it('names an empty filter, which authors as a block nothing fits inside', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [{ id: 'featured-story-card', fields: [{ component: 'text', name: 'a', label: 'A' }] }],
      filters: [{ id: 'featured-story-card', components: [] }],
    });
    expect(markdown).toContain('names no components');
  });

  it('names an image with nowhere to write alt text', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [
        { id: 'featured-story-card', fields: [{ component: 'reference', name: 'image', label: 'Image' }] },
      ],
    });
    expect(markdown).toContain('accessibility failure');
  });

  it('names a choice with nothing to choose from, and a field with no label', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [{ id: 'featured-story-card', fields: [{ component: 'select', name: 'size' }] }],
    });
    expect(markdown).toContain('offers a choice but lists no options');
    expect(markdown).toContain('has no label');
  });

  it('names a definition pointing at a model that is not there', () => {
    const markdown = guide({ definitions: [BLOCK_DEFINITION], models: [] });
    expect(markdown).toContain('that is not in this document');
  });

  it('names a container field mixed with a separate item definition', () => {
    const markdown = guide({
      definitions: [
        BLOCK_DEFINITION,
        {
          title: 'Card',
          id: 'card',
          plugins: {
            xwalk: {
              page: { resourceType: 'core/franklin/components/block/v1/block/item', template: { model: 'card' } },
            },
          },
        },
      ],
      models: [
        { id: 'featured-story-card', fields: [{ component: 'container', name: 'cards', label: 'Cards' }] },
        { id: 'card', fields: [{ component: 'text', name: 'headline', label: 'Headline' }] },
      ],
      filters: [{ id: 'featured-story-card', components: ['card'] }],
    });
    expect(markdown).toContain('two different ways to repeat something');
  });

  it('does not claim a clean proposal is a correct one', () => {
    const markdown = guide({
      definitions: [BLOCK_DEFINITION],
      models: [
        { id: 'featured-story-card', fields: [{ component: 'text', name: 'headline', label: 'Headline' }] },
      ],
    });
    expect(markdown).toContain('That is not the same as it being right.');
  });
});
