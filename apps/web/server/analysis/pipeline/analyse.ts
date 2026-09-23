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
import { describeDigest } from '../design/digest';
import { DesignSourceError } from '../design/errors';
import type { DesignReference } from '../design/link';
import type { AnalysisRun } from '../registry';
import { DESIGN_FILE, GAPS_FILE, REQUIREMENTS_FILE, TICKET_FILE, writeArtifact, writeJson, writeRecord } from '../store';
import { checkClaims, checkElements, checkEvidence, evidenceSets } from './evidence';
import { contentModelPass, designInventoryPass, reconcilePass, ticketClaimsPass } from './passes';
import { renderRequirements } from './render';
import type { ArmCaller, PassResult } from './runner';
import { PassError, runPass } from './runner';

export interface AnalyseOptions {
  storageDir: string;
  analysisId: string;
  blockName: string;
  armId: string;
  armParams?: Record<string, unknown>;
  reference: DesignReference;
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

  // --- The design -----------------------------------------------------------

  run.start('design');
  let design: NormalisedDesign;
  try {
    const read = await options.design.read(options.reference, {
      ...(options.armReadsImages ? { wantRender: true } : {}),
    });
    design = read.design;

    if (read.render) {
      await writeArtifact(storageDir, analysisId, 'design.png', read.render.bytes);
      design.renderId = 'design.png';
    }

    await writeJson(storageDir, analysisId, DESIGN_FILE, design);
    run.describe('design', describeDigest({
      digest: design.digest,
      nodeIds: design.nodeIds,
      droppedNodes: design.droppedNodes,
      ...(design.truncatedAtDepth === undefined ? {} : { truncatedAtDepth: design.truncatedAtDepth }),
    }));
    if (read.degraded.length > 0) run.note('design', read.degraded.join('\n'));
    run.done('design');
  } catch (error) {
    // A design-source failure keeps its own reason all the way here, because
    // "Figma is closed" and "that node is not in the open file" need different
    // things from the person at the keyboard.
    return fail('design', error instanceof DesignSourceError ? error : error);
  }

  record.design = {
    adapter: design.adapter,
    fileKey: design.fileKey,
    nodeId: design.nodeId,
    ...(design.name ? { name: design.name } : {}),
  };

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
  const sets = evidenceSets(design.nodeIds, [
    ...ticket.passages.map((passage) => passage.id),
    ...ticket.comments.map((_comment, at) => `c${at + 1}`),
  ]);

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

  const inventory = await pass(designInventoryPass(design, blockName), 'pass1');
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
    design,
    ticket,
    requirements: checked.requirements,
    inferences: checked.inferences,
    gaps: checked.gaps,
  });

  const fileName = modelFileName(blockName);
  await writeArtifact(storageDir, analysisId, REQUIREMENTS_FILE, markdown);
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
  };
}

export type { DesignElement, TicketClaim };
