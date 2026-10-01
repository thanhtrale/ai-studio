/**
 * The readable consolidation, rendered from pass 3's JSON.
 *
 * Rendered rather than generated. A fifth pass asked to write this up would be
 * one more place for a sentence to appear in the prose that is not in the data
 * -- and the data is what everything else is checked against. Nothing here
 * decides anything; it only formats what survived the evidence check.
 */

import type {
  AnalysisRecord,
  Evidence,
  Gap,
  GapKind,
  Inference,
  NormalisedDesign,
  NormalisedTicket,
  Requirement,
} from '#shared/analysis';

const GAP_HEADING: Record<GapKind, string> = {
  contradiction: 'Contradictions — the design wins, the ticket needs correcting',
  'not-in-design': 'In the ticket, not in the design',
  undocumented: 'In the design, not in the ticket',
  ambiguous: 'Undetermined',
};

/** The order they are worth reading in: disagreements first, vagueness last. */
const GAP_ORDER: GapKind[] = ['contradiction', 'not-in-design', 'undocumented', 'ambiguous'];

/**
 * Passage ids, turned back into something a person recognises.
 *
 * The ids are ordinals because a model has to copy them exactly; `p3` is not
 * what a reader wants to see beside a requirement. The heading is.
 */
function passageNames(ticket: NormalisedTicket): Map<string, string> {
  const names = new Map<string, string>();
  for (const passage of ticket.passages) names.set(passage.id, passage.heading);
  ticket.comments.forEach((comment, at) => {
    names.set(`c${at + 1}`, comment.createdAt ? `comment, ${comment.createdAt}` : 'comment');
  });
  return names;
}

function citations(evidence: Evidence, names: Map<string, string>): string[] {
  return [
    ...evidence.nodeIds.map((id) => `\`#${id}\``),
    ...evidence.passageIds.map((id) => {
      const heading = names.get(id);
      return heading ? `*${heading}*` : `\`${id}\``;
    }),
  ];
}

function evidenceOf(requirement: Requirement, names: Map<string, string>): string {
  const parts = citations(requirement.evidence, names);
  return parts.length ? ` <sub>${parts.join(' ')}</sub>` : '';
}

export interface RenderGapsInput {
  record: Pick<AnalysisRecord, 'blockName'>;
  ticket: NormalisedTicket;
  gaps: readonly Gap[];
  inferences: readonly Inference[];
}

/**
 * The gaps on their own, as a list of questions to take to a person.
 *
 * `requirements.md` already carries the gaps, and this is not a duplicate of
 * that section -- it is a different use. The requirement document is read top
 * to bottom to learn what the block is; this is read in a meeting, one item at
 * a time, to close the things nobody has decided. So each gap gets a heading of
 * its own and the question is the last line, where it is easiest to act on.
 *
 * The machine's copy of the same material is `gaps.json`, which is what a tool
 * reads. This is what a person reads.
 */
export function renderGaps(input: RenderGapsInput): string {
  const { record, ticket, gaps, inferences } = input;
  const names = passageNames(ticket);
  const out: string[] = [];

  out.push(`# ${record.blockName} — open questions (${gaps.length})`);
  out.push('');

  if (gaps.length === 0) {
    out.push('_Nothing was left undecided. On a real ticket that is worth being suspicious about._');
    out.push('');
  } else {
    out.push(
      '> Each of these needs an answer from a person. The design is the authority on what exists, ' +
        'so where the two sources disagree it is the ticket that needs correcting, not the design.',
    );
    out.push('');
  }

  const byKind = GAP_ORDER.map((kind) => ({
    kind,
    entries: gaps.filter((gap) => gap.kind === kind),
  })).filter((group) => group.entries.length > 0);

  for (const group of byKind) {
    out.push(`## ${GAP_HEADING[group.kind]} (${group.entries.length})`);
    out.push('');
    for (const gap of group.entries) {
      out.push(`### ${gap.statement}`);
      out.push('');
      if (gap.designReading) out.push(`- **The design shows:** ${gap.designReading}`);
      if (gap.ticketReading) out.push(`- **The ticket claims:** ${gap.ticketReading}`);
      const cited = citations(gap.evidence, names);
      if (cited.length) out.push(`- Evidence: ${cited.join(' ')}`);
      out.push(`- **Ask:** ${gap.question}`);
      out.push('');
    }
  }

  if (inferences.length > 0) {
    out.push(`## Unsupported statements (${inferences.length})`);
    out.push('');
    out.push(
      '_Stated by the model and supported by neither source. Not questions for anybody — they are ' +
        'here because a guess is often right, and because seeing what the model reached for says ' +
        'something about the run._',
    );
    out.push('');
    for (const inference of inferences) {
      out.push(`- ${inference.statement}`);
      out.push(`  - _${inference.reason}_`);
    }
    out.push('');
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export interface RenderInput {
  record: Pick<AnalysisRecord, 'blockName' | 'armId' | 'startedAt'>;
  /** Every frame that was read, in the order they were given. */
  designs: readonly NormalisedDesign[];
  ticket: NormalisedTicket;
  requirements: readonly Requirement[];
  inferences: readonly Inference[];
  gaps: readonly Gap[];
}

export function renderRequirements(input: RenderInput): string {
  const { record, designs, ticket } = input;
  const names = passageNames(ticket);
  const out: string[] = [];

  out.push(`# ${record.blockName}`);
  out.push('');

  // One line per frame. A reader has to be able to tell a requirement drawn
  // from three viewports from one drawn from a single desktop frame, because
  // the second says nothing at all about what happens on a phone.
  const frames = designs.map((design) => {
    const where = `Figma \`${design.fileKey}\` node \`${design.nodeId}\``;
    const size = design.width === undefined ? '' : `, ${Math.round(design.width)} wide`;
    return designs.length === 1
      ? `Design — ${where}${design.name ? ` (${design.name})` : ''}`
      : `Design — ${design.label}${size} — ${where}`;
  });

  const sources = [
    ...frames,
    `Ticket — ${ticket.key ?? 'imported'}${ticket.summary ? `: ${ticket.summary}` : ''} (${ticket.format})`,
    `Analysed by \`${record.armId}\` on ${record.startedAt.slice(0, 10)}`,
  ];
  out.push(sources.map((line) => `- ${line}`).join('\n'));
  out.push('');
  out.push(
    '> The design is the source of truth. Where the two sources disagreed, the requirement below ' +
      'states what the design shows and the disagreement is recorded under Gaps.',
  );
  out.push('');

  out.push('## Requirements');
  out.push('');
  if (input.requirements.length === 0) {
    out.push('_Nothing survived the evidence check. That is a finding about the run, not about the block._');
  } else {
    out.push(
      input.requirements
        .map((requirement) => `- ${requirement.statement}${evidenceOf(requirement, names)}`)
        .join('\n'),
    );
  }
  out.push('');

  const byKind = GAP_ORDER.map((kind) => ({
    kind,
    entries: input.gaps.filter((gap) => gap.kind === kind),
  })).filter((group) => group.entries.length > 0);

  out.push(`## Gaps (${input.gaps.length})`);
  out.push('');
  if (byKind.length === 0) {
    out.push('_None found._');
    out.push('');
  }

  for (const group of byKind) {
    out.push(`### ${GAP_HEADING[group.kind]}`);
    out.push('');
    for (const gap of group.entries) {
      out.push(`- **${gap.statement}**`);
      if (gap.designReading) out.push(`  - Design: ${gap.designReading}`);
      if (gap.ticketReading) out.push(`  - Ticket: ${gap.ticketReading}`);
      out.push(`  - **Ask:** ${gap.question}`);
      const cited = citations(gap.evidence, names);
      if (cited.length) out.push(`  - ${cited.join(' ')}`);
    }
    out.push('');
  }

  if (input.inferences.length > 0) {
    out.push(`## Inferences (${input.inferences.length})`);
    out.push('');
    out.push(
      '_Stated by the model, supported by neither source. Kept because a guess is often right ' +
        'and always worth a question — but none of these is a requirement._',
    );
    out.push('');
    for (const inference of input.inferences) {
      out.push(`- ${inference.statement}`);
      out.push(`  - _${inference.reason}_`);
    }
    out.push('');
  }

  const notes: string[] = [];
  const dropped = designs.reduce((total, design) => total + design.droppedNodes, 0);
  if (dropped > 0) {
    notes.push(`${dropped} hidden or decorative nodes were removed from the design outline.`);
  }
  // Named individually: one viewport being cut and another not is the kind of
  // asymmetry that would otherwise explain a strange finding silently.
  for (const design of designs.filter((entry) => entry.truncatedAtDepth !== undefined)) {
    notes.push(
      designs.length === 1
        ? `The design outline was cut at depth ${design.truncatedAtDepth} to fit the context.`
        : `The ${design.label} outline was cut at depth ${design.truncatedAtDepth} to fit the context.`,
    );
  }
  if (ticket.attachments.length > 0) {
    notes.push(
      `${ticket.attachments.length} ticket attachment${ticket.attachments.length === 1 ? '' : 's'} ` +
        `(${ticket.attachments.map((entry) => entry.name).join(', ')}) ` +
        'were named but not read: the import path carries no credentials.',
    );
  }
  if (ticket.comments.length > 0) {
    notes.push(`${ticket.comments.length} comment${ticket.comments.length === 1 ? ' was' : 's were'} read as part of the ticket.`);
  }

  if (notes.length > 0) {
    out.push('## What was not read');
    out.push('');
    out.push(notes.map((note) => `- ${note}`).join('\n'));
    out.push('');
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
