/**
 * The four passes: what each one is shown, and what it is asked for.
 *
 * The ordering is the design. Passes 1 and 2 read one source each, in
 * isolation: pass 1 never sees the ticket and pass 2 never sees the design.
 * That is not an economy, it is the point. A model handed both at once writes
 * one fluent description in which every disagreement has quietly been resolved
 * by assumption -- and the disagreements are the product. Two independent
 * inventories can be diffed; one synthesis cannot.
 *
 * Pass 3 is the only one that sees both, and it sees the two short structured
 * lists rather than the raw sources, which is also what leaves it room to
 * reason. Pass 4 models, which is a different skill from reconciling and is
 * validated differently.
 *
 * There is no pass that writes prose. `requirements.md` is rendered from pass
 * 3's JSON in code, because a model asked to prettify its own structured output
 * is an opportunity for a sentence to appear in the prose that is not in the
 * data.
 */

import type {
  DesignElement,
  NormalisedDesign,
  NormalisedTicket,
  TicketClaim,
  UeBlockModel,
} from '#shared/analysis';

import type { PassDefinition } from './runner';
import type { ReconcileOutput } from './schema';
import { validateBlockModel, validateClaims, validateElements, validateReconcile } from './schema';

const JSON_ONLY =
  'Answer with one JSON document and nothing else: no prose before it, no code fence around it, ' +
  'no commentary after it.';

/** Every pass is told this, because every pass can be tempted to fill a gap. */
const NO_INVENTION =
  'Never invent an id. Every id you cite must appear verbatim in the material above. ' +
  'If you cannot support a statement with an id from the material, leave the id list empty ' +
  'rather than choosing a plausible one -- an unsupported statement is still useful, ' +
  'a wrongly attributed one is not.';

function ticketText(ticket: NormalisedTicket): string {
  const head = [
    ticket.key ? `Key: ${ticket.key}` : '',
    ticket.summary ? `Summary: ${ticket.summary}` : '',
    ticket.type ? `Type: ${ticket.type}` : '',
    ticket.status ? `Status: ${ticket.status}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const passages = ticket.passages
    .map((passage) => `[${passage.id}] ${passage.heading}\n${passage.body}`)
    .join('\n\n');

  // Comments are included and labelled. A requirement agreed in a thread and
  // never written back into the description exists only there.
  const comments = ticket.comments.length
    ? `\n\nCOMMENTS (these may contradict the description; both are the ticket)\n` +
      ticket.comments
        .map((comment, at) => `[c${at + 1}] ${comment.createdAt ?? ''}\n${comment.body}`)
        .join('\n\n')
    : '';

  const attachments = ticket.attachments.length
    ? `\n\nATTACHMENTS (named only -- their contents were not read)\n` +
      ticket.attachments.map((entry) => `- ${entry.name}`).join('\n')
    : '';

  return `${head}\n\n${passages}${comments}${attachments}`.trim();
}

function designText(design: NormalisedDesign): string {
  const tokens = design.tokens.length
    ? `\n\nDESIGN TOKENS used in this frame\n` +
      design.tokens.map((token) => `- ${token.name} = ${token.value}`).join('\n')
    : '';

  const interpretation = design.interpretation
    ? `\n\nFIGMA'S OWN CODE GUESS -- this is an interpretation, in a framework this project does ` +
      `not use. Treat it as evidence about styling and grouping only. It carries no node ids, ` +
      `so nothing in it may be cited.\n${design.interpretation}`
    : '';

  const reduction = [
    design.droppedNodes > 0 ? `${design.droppedNodes} hidden or decorative nodes were removed` : '',
    design.truncatedAtDepth !== undefined ? `the tree was cut at depth ${design.truncatedAtDepth}` : '',
  ].filter(Boolean);

  const note = reduction.length ? `\n\n(This outline is a reduction: ${reduction.join('; ')}.)` : '';

  return `DESIGN OUTLINE -- one line per layer, indented by nesting.
Format: #<nodeId> <TYPE> "<name>" <width>x<height> [layout/gap] [of:"component"] [variant:"..."] [image-fill] [text:"..."]

${design.digest}${note}${tokens}${interpretation}`;
}

/** Pass 1 · the design, with the ticket unseen. */
export function designInventoryPass(
  design: NormalisedDesign,
  blockName: string,
): PassDefinition<DesignElement[]> {
  return {
    id: 'p1',
    step: 'pass1',
    validate: validateElements,
    request: {
      maxTokens: 6144,
      system:
        'You read a Figma frame and enumerate what it contains. You are specifying a block for ' +
        'Adobe Experience Manager Edge Delivery Services, so you care about what an author would ' +
        'have to fill in and what a visitor would see -- not about pixel values.\n\n' +
        'You have not been shown any ticket or written requirement, and you must not assume one. ' +
        'Describe only what the outline shows.\n\n' +
        NO_INVENTION +
        '\n\n' +
        JSON_ONLY,
      messages: [
        {
          role: 'user',
          content: `${designText(design)}

The block is called "${blockName}".

List every element of this block that carries content or affords an interaction. Skip pure layout
containers that hold nothing an author would edit.

Return:

{"elements": [
  {"nodeId": "<the id alone from the outline above -- e.g. for #1:23 write 1:23, without the # >",
   "role": "<what it is for, in the block's own terms: eyebrow, headline, body, hero-image, thumbnail, cta-primary, ...>",
   "kind": "frame|text|image|icon|button|link|input|container|other",
   "sample": "<its text, or a short description of the visual>",
   "repeated": <true when the same component appears more than once at this level>,
   "variant": "<the variant name, when the outline gives one>"}
]}`,
        },
      ],
    },
  };
}

/** Pass 2 · the ticket, with the design unseen. */
export function ticketClaimsPass(ticket: NormalisedTicket): PassDefinition<TicketClaim[]> {
  return {
    id: 'p2',
    step: 'pass2',
    validate: validateClaims,
    request: {
      // The largest output of the four. A ticket with a Given/When/Then table
      // and a twelve-row field specification yields dozens of claims, and a
      // real one overflowed 4096 part-way through an object.
      maxTokens: 12288,
      system:
        'You read a Jira ticket and extract every separate thing it asserts about the component ' +
        'being built.\n\n' +
        'You have not been shown the design, and you must not assume what it looks like. Extract ' +
        'what the ticket says, including anything it says that may turn out to be wrong. Do not ' +
        'merge two claims because they are about the same element, and do not drop a claim for ' +
        'being vague -- a vague claim is a finding.\n\n' +
        'The comments are part of the ticket. Where a comment says something the description does ' +
        'not, or contradicts it, extract both as separate claims.\n\n' +
        NO_INVENTION +
        '\n\n' +
        JSON_ONLY,
      messages: [
        {
          role: 'user',
          content: `${ticketText(ticket)}

Return:

{"claims": [
  {"id": "c1",
   "passageId": "<the label this came from, without the brackets: p1, p2, c1, ...>",
   "statement": "<one assertion, in one sentence>",
   "kind": "content|behaviour|layout|constraint|authoring|accessibility|analytics"}
]}`,
        },
      ],
    },
  };
}

/** Pass 3 · the only pass that sees both, and it sees the two lists. */
export function reconcilePass(
  elements: readonly DesignElement[],
  claims: readonly TicketClaim[],
  blockName: string,
): PassDefinition<ReconcileOutput> {
  return {
    id: 'p3',
    step: 'pass3',
    validate: validateReconcile,
    request: {
      maxTokens: 12288,
      system:
        'You reconcile what a design shows with what a ticket claims, for one block.\n\n' +
        'THE DESIGN IS THE SOURCE OF TRUTH. Where the two disagree about something observable, ' +
        'the design’s reading becomes the requirement and the ticket’s becomes a ' +
        'contradiction. Never resolve a disagreement by preferring the ticket, and never drop ' +
        'either side quietly.\n\n' +
        'Your value is in what you refuse to smooth over. A requirement list that reads as though ' +
        'the two sources agreed is a failure, because they rarely do.\n\n' +
        NO_INVENTION +
        '\n\n' +
        JSON_ONLY,
      messages: [
        {
          role: 'user',
          content: `BLOCK: ${blockName}

WHAT THE DESIGN CONTAINS (each carries the node id it came from)
${JSON.stringify(elements, null, 1)}

WHAT THE TICKET CLAIMS (each carries the passage id it came from)
${JSON.stringify(claims, null, 1)}

Produce the consolidated requirement and the gaps between the two.

Rules for gaps:
- "not-in-design": the ticket describes something with no counterpart in the design. It is NOT a
  requirement, because the design is the authority on what exists.
- "undocumented": the design shows something the ticket never describes. It IS a requirement --
  and also a gap, because the ticket needs updating.
- "contradiction": the two disagree. The requirement states the design's reading; designReading
  and ticketReading both record what each said.
- "ambiguous": visible in the design but undetermined -- a truncation rule, an empty state, a
  breakpoint the design does not cover, a limit nobody stated.

Every gap needs a question a person can answer. A gap with no question is not reported.

Return:

{"requirements": [
  {"id": "r1",
   "statement": "<one requirement, in one sentence>",
   "nodeIds": ["<ids from the design list>"],
   "passageIds": ["<ids from the ticket list>"]}
 ],
 "gaps": [
  {"id": "g1",
   "kind": "not-in-design|undocumented|contradiction|ambiguous",
   "statement": "<what the gap is>",
   "designReading": "<what the design shows -- required for a contradiction>",
   "ticketReading": "<what the ticket claims>",
   "nodeIds": [], "passageIds": [],
   "question": "<the question to put to a person>"}
 ]}`,
        },
      ],
    },
  };
}

/** Pass 4 · the content model. */
export function contentModelPass(
  elements: readonly DesignElement[],
  reconciled: ReconcileOutput,
  blockName: string,
): PassDefinition<UeBlockModel> {
  const id = blockName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const title = blockName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return {
    id: 'p4',
    step: 'pass4',
    validate: validateBlockModel,
    request: {
      maxTokens: 6144,
      system:
        'You write the Universal Editor content model for one Adobe Experience Manager Edge ' +
        'Delivery Services block, in the form the aem-boilerplate-xwalk project merges from ' +
        '`blocks/<name>/_<name>.json`.\n\n' +
        'The document has exactly three top-level arrays: definitions, models and filters. All ' +
        'three are present even when one is empty.\n\n' +
        'Field components available: text, richtext, number, select, multiselect, boolean, ' +
        'checkbox-group, radio-group, date-time, reference (an asset), aem-content (a link), ' +
        'aem-tag, container, tab.\n\n' +
        'Conventions that are not optional:\n' +
        '- A block that repeats a child is a container: one definition with resourceType ' +
        '"core/franklin/components/block/v1/block" and a filter, plus one definition for the item ' +
        'with resourceType "core/franklin/components/block/v1/block/item" and its own model.\n' +
        '- A simple block has one definition with the block resource type, a model, and an empty ' +
        'filters array.\n' +
        '- An image is a `reference` field plus a sibling `<name>Alt` text field. A link is an ' +
        '`aem-content` field plus `<name>Text` and optionally `<name>Title`. Those suffixes are ' +
        'how the editor collapses several fields into one element.\n' +
        '- Visual variants are NOT content. They belong in the classes group: a field named ' +
        '`classes` (select or multiselect), or `classes_<something>` for a second axis. They reach ' +
        'the block as CSS classes.\n\n' +
        JSON_ONLY,
      messages: [
        {
          role: 'user',
          content: `BLOCK: ${blockName}  (id "${id}", title "${title}")

WHAT THE DESIGN CONTAINS
${JSON.stringify(elements, null, 1)}

THE CONSOLIDATED REQUIREMENT
${JSON.stringify(reconciled.requirements, null, 1)}

OPEN QUESTIONS -- model what is decided; do not invent a field to settle one of these
${JSON.stringify(
  reconciled.gaps.map((gap) => gap.question),
  null,
  1,
)}

Return the document:

{"definitions": [
  {"title": "${title}", "id": "${id}",
   "plugins": {"xwalk": {"page": {"resourceType": "core/franklin/components/block/v1/block",
     "template": {"name": "${title}", "model": "${id}"}}}}}
 ],
 "models": [{"id": "${id}", "fields": [{"component": "...", "name": "...", "label": "...", "valueType": "string"}]}],
 "filters": []}`,
        },
      ],
    },
  };
}
