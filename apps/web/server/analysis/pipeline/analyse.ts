/**
 * The whole run: two sources, four passes, three artefacts.
 *
 * Read the design, read the ticket, **write both to disk**, then run the
 * passes. The order of those is the one part worth defending: the registry is
 * module state and a Nuxt reload empties it, so an analysis interrupted at pass
 * 3 must still leave its digest and its ticket readable or the rerun pays for
 * them again.
 */

import type {
  AnalysisRecord,
  AnalysisResult,
  DesignElement,
  NormalisedDesign,
  NormalisedTicket,
  TicketClaim,
} from '#shared/analysis';

import type { DesignSource } from '../design/source';
import { describeDigest, shareDigestBudget } from '../design/digest';
import { DesignSourceError } from '../design/errors';
import type { DesignReference } from '../design/link';
import type { AnalysisRun } from '../registry';
import { AUTHORING_FILE, DESIGN_FILE, GAPS_FILE, GAPS_MD_FILE, REQUIREMENTS_FILE, TICKET_FILE, writeArtifact, writeJson, writeRecord } from '../store';
import { checkClaims, checkElements, checkEvidence, evidenceSets } from './evidence';
import { contentModelPass, designInventoryPass, reconcilePass, ticketClaimsPass } from './passes';
import { renderAuthoringGuide } from './authoring';
import { renderGaps, renderRequirements } from './render';
import type { ArmCaller, PassResult } from './runner';
import { PassError, runPass } from './runner';

export interface AnalyseOptions {
  storageDir: string;
  analysisId: string;
  blockName: string;
  armId: string;
  armParams?: Record<string, unknown>;
  /**
   * The frames to read, in the order they were given.
   *
   * Several of them are one block drawn at several viewports. The first is the
   * primary view -- it is the one Figma's code guess and the rendering are
   * taken for, and the one the report leads with -- so the console asks for the
   * widest first rather than reordering behind the person's back.
   */
  references: readonly DesignReference[];
  ticket: NormalisedTicket;
  design: DesignSource;
  caller: ArmCaller;
  run: AnalysisRun;
  /** True when the chosen arm can read images, so a rendering is worth taking. */
  armReadsImages?: boolean;
}

/** The file the proposed model is written as, and offered for copying. */
export function modelFileName(blockName: string): string {
  const id = blockName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  return `_${id}.json`;
}

function countNote(label: string, count: number): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

/**
 * Gives every view a label no other view in this run has.
 *
 * Two frames may honestly be called the same thing -- a designer naming both
 * breakpoints "Card" is not a mistake -- and nothing cites a label, so this is
 * purely so that a person reading the report can tell which reading came from
 * which frame. An unnamed frame falls back to its position.
 */
function labelViews(designs: readonly NormalisedDesign[]): void {
  const used = new Map<string, number>();
  designs.forEach((design, at) => {
    const base = design.name?.trim() || `view ${at + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    design.label = seen === 0 ? base : `${base} (${seen + 1})`;
  });
}

/** The one-line qualifier the timeline shows once every frame has been read. */
function describeViews(designs: readonly NormalisedDesign[]): string {
  const first = designs[0];
  if (designs.length === 1 && first) {
    return describeDigest({
      digest: first.digest,
      nodeIds: first.nodeIds,
      droppedNodes: first.droppedNodes,
      ...(first.truncatedAtDepth === undefined ? {} : { truncatedAtDepth: first.truncatedAtDepth }),
    });
  }

  const nodes = designs.reduce((total, design) => total + design.nodeIds.length, 0);
  const dropped = designs.reduce((total, design) => total + design.droppedNodes, 0);
  return [
    countNote('view', designs.length),
    countNote('node', nodes),
    dropped > 0 ? `${dropped} dropped` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export async function analyse(options: AnalyseOptions): Promise<AnalysisResult> {
  const { storageDir, analysisId, blockName, armId, run } = options;
  const startedAt = new Date().toISOString();

  const record: AnalysisRecord = {
    analysisId,
    blockName,
    armId,
    state: 'running',
    startedAt,
  };
  await writeRecord(storageDir, record);

  const fail = async (step: string, error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    run.fail(step, message);
    record.state = 'failed';
    record.detail = message;
    record.endedAt = new Date().toISOString();
    await writeRecord(storageDir, record);
    throw error;
  };

  // --- The design, at every viewport it was given ---------------------------

  run.start('design');
  const designs: NormalisedDesign[] = [];
  try {
    const views = options.references.length;
    // One budget, shared. Reading a block at three widths is not a reason to
    // spend three times the context on it -- the three trees are near-identical
    // and it is the differences between them that are worth the room.
    const digest = shareDigestBudget(views);

    for (const [at, reference] of options.references.entries()) {
      // A frame is a round trip to another application, so a run that reads
      // three of them owes the person watching some sign of which one it is on.
      if (views > 1) run.describe('design', `frame ${at + 1} of ${views}…`);

      const read = await options.design.read(reference, {
        // Both of these are taken once, for the primary view. The rendering is
        // seconds and VRAM; Figma's code guess is six thousand characters that
        // carry no citable id. Neither says anything about the narrower frames
        // that the first one has not already said.
        ...(options.armReadsImages && at === 0 ? { wantRender: true } : {}),
        wantInterpretation: at === 0,
        digest,
      });

      if (read.render) {
        await writeArtifact(storageDir, analysisId, 'design.png', read.render.bytes);
        read.design.renderId = 'design.png';
      }
      if (read.degraded.length > 0) {
        run.note('design', read.degraded.map((entry) => `${read.design.label}: ${entry}`).join('\n'));
      }

      designs.push(read.design);
    }

    labelViews(designs);
    await writeJson(storageDir, analysisId, DESIGN_FILE, designs);
    run.describe('design', describeViews(designs));
    run.done('design');
  } catch (error) {
    // A design-source failure keeps its own reason all the way here, because
    // "Figma is closed" and "that node is not in the open file" need different
    // things from the person at the keyboard.
    return fail('design', error instanceof DesignSourceError ? error : error);
  }

  record.designs = designs.map((design) => ({
    adapter: design.adapter,
    fileKey: design.fileKey,
    nodeId: design.nodeId,
    label: design.label,
    ...(design.name ? { name: design.name } : {}),
    ...(design.width === undefined ? {} : { width: design.width }),
  }));

  // --- The ticket -----------------------------------------------------------

  run.start('ticket');
  const ticket = options.ticket;
  await writeJson(storageDir, analysisId, TICKET_FILE, ticket);
  run.describe(
    'ticket',
    [
      ticket.key ?? ticket.format,
      countNote('passage', ticket.passages.length),
      ticket.comments.length > 0 ? countNote('comment', ticket.comments.length) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  run.done('ticket');

  record.ticket = {
    format: ticket.format,
    ...(ticket.key ? { key: ticket.key } : {}),
    ...(ticket.summary ? { summary: ticket.summary } : {}),
  };
  await writeRecord(storageDir, record);

  // Ids the sources actually produced. Comments are citable too, under the
  // `c1`, `c2` names the prompt labels them with -- the same shape as a
  // passage id, and for the same reason: short enough to copy exactly.
  //
  // Every view's ids go into one set, so an element seen in the design may be
  // cited from whichever frame showed it best. That union is sound only because
  // the links were required to be to a single Figma file: node ids are unique
  // within a file and mean nothing across two, so a set spanning files could
  // verify a citation against a frame it never came from.
  const sets = evidenceSets(
    designs.flatMap((design) => design.nodeIds),
    [
      ...ticket.passages.map((passage) => passage.id),
      ...ticket.comments.map((_comment, at) => `c${at + 1}`),
    ],
  );

  const pass = async <T>(
    definition: Parameters<typeof runPass<T>>[0],
    step: string,
  ): Promise<PassResult<T>> => {
    run.start(step);
    try {
      const result = await runPass(definition, {
        armId,
        ...(options.armParams ? { armParams: options.armParams } : {}),
        analysisId,
        caller: options.caller,
        run,
      });
      await writeArtifact(
        storageDir,
        analysisId,
        `passes/${definition.id}.json`,
        `${JSON.stringify({ raw: result.raw, value: result.value, repaired: result.repaired }, null, 2)}\n`,
      );
      return result;
    } catch (error) {
      if (error instanceof PassError) {
        await writeArtifact(storageDir, analysisId, `passes/${definition.id}-failed.txt`, error.raw);
      }
      return fail(step, error);
    }
  };

  // --- Pass 1 and pass 2: one source each, in isolation ---------------------

  const inventory = await pass(designInventoryPass(designs, blockName), 'pass1');
  const elements = checkElements(inventory.value, sets);
  if (elements.dropped.length > 0) {
    run.note('pass1', `${elements.dropped.length} element(s) cited a node id that is not in the design`);
  }
  run.describe('pass1', countNote('element', elements.kept.length) + (inventory.repaired ? ' · repaired' : ''));
  run.done('pass1');

  const claimsPass = await pass(ticketClaimsPass(ticket), 'pass2');
  const claims = checkClaims(claimsPass.value, sets);
  if (claims.dropped.length > 0) {
    run.note('pass2', `${claims.dropped.length} claim(s) cited a passage that is not in the ticket`);
  }
  run.describe('pass2', countNote('claim', claims.kept.length) + (claimsPass.repaired ? ' · repaired' : ''));
  run.done('pass2');

  // --- Pass 3: the only one that sees both ---------------------------------

  const reconciled = await pass(reconcilePass(elements.kept, claims.kept, blockName), 'pass3');
  const checked = checkEvidence(reconciled.value, sets);
  run.describe(
    'pass3',
    [
      countNote('requirement', checked.requirements.length),
      countNote('gap', checked.gaps.length),
      checked.inferences.length > 0 ? countNote('inference', checked.inferences.length) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (checked.inferences.length > 0) {
    run.note('pass3', `${checked.inferences.length} statement(s) had no evidence and were demoted`);
  }
  run.done('pass3');

  // --- Pass 4: the content model -------------------------------------------

  const model = await pass(contentModelPass(elements.kept, reconciled.value, blockName), 'pass4');
  run.describe(
    'pass4',
    [
      countNote('field', model.value.models.reduce((total, entry) => total + entry.fields.length, 0)),
      countNote('definition', model.value.definitions.length),
    ].join(' · '),
  );
  run.done('pass4');

  // --- The artefacts --------------------------------------------------------

  run.start('write');
  const markdown = renderRequirements({
    record,
    designs,
    ticket,
    requirements: checked.requirements,
    inferences: checked.inferences,
    gaps: checked.gaps,
  });

  // Two readings of material already decided, and one serialisation of it.
  // Rendered here rather than in the browser so that the run on disk and the
  // run on screen are the same run -- a console is not the only thing that
  // reads an analysis.
  const gapsMarkdown = renderGaps({
    record,
    ticket,
    gaps: checked.gaps,
    inferences: checked.inferences,
  });
  const authoringMarkdown = renderAuthoringGuide(model.value, blockName);

  const fileName = modelFileName(blockName);
  await writeArtifact(storageDir, analysisId, REQUIREMENTS_FILE, markdown);
  await writeArtifact(storageDir, analysisId, GAPS_MD_FILE, gapsMarkdown);
  await writeArtifact(storageDir, analysisId, AUTHORING_FILE, authoringMarkdown);
  await writeJson(storageDir, analysisId, GAPS_FILE, {
    gaps: checked.gaps,
    inferences: checked.inferences,
  });
  await writeJson(storageDir, analysisId, fileName, model.value);

  record.state = 'done';
  record.endedAt = new Date().toISOString();
  record.counts = {
    requirements: checked.requirements.length,
    inferences: checked.inferences.length,
    gaps: checked.gaps.length,
  };
  await writeRecord(storageDir, record);

  run.describe('write', fileName);
  run.done('write');
  run.finish();

  return {
    record,
    requirements: checked.requirements,
    inferences: checked.inferences,
    gaps: checked.gaps,
    model: model.value,
    markdown,
    gapsMarkdown,
    authoringMarkdown,
  };
}

export type { DesignElement, TicketClaim };
