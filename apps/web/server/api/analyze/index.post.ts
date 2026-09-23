import type { AnalysisRequest, NormalisedTicket } from '#shared/analysis';

import { FigmaMcpSource } from '../../analysis/design/source';
import { parseFigmaLink } from '../../analysis/design/link';
import { analyse } from '../../analysis/pipeline/analyse';
import type { ArmCaller } from '../../analysis/pipeline/runner';
import { createRun, forgetRun } from '../../analysis/registry';
import { isAnalysisId } from '../../analysis/store';
import { relay, supervisorClient } from '../../utils/relay';
import { RelayError } from '../../utils/supervisor';

/** The capability an arm must declare to run the passes. */
const REQUIRED_CAPABILITY = 'text.generate';

/**
 * Submits an analysis.
 *
 * Everything that could be refused cheaply is refused before anything expensive
 * happens: the link, the ticket, the id, and whether there is an arm that can
 * serve this at all. Discovering at pass 1 that no arm declares `text.generate`
 * would be a failure after a Figma round trip and two files on disk.
 *
 * The response returns when the analysis finishes, which is minutes. The
 * console does not wait for it -- it polls `/api/analyze/<id>`, which is why
 * the id is chosen by the browser rather than returned from here.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = await readBody<AnalysisRequest>(event);

  const analysisId = body?.analysisId;
  if (!isAnalysisId(analysisId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'analysisId is required and must be a plain identifier of 8 to 56 characters' },
    });
  }

  const blockName = typeof body?.blockName === 'string' ? body.blockName.trim() : '';
  if (!blockName) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'a block name is required' },
    });
  }

  const ticket: NormalisedTicket | undefined = body?.ticket;
  if (!ticket?.description?.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'a ticket is required -- import or paste one first' },
    });
  }

  return relay(async () => {
    // Throws with the reason: not Figma, no node in the link, no file key.
    const reference = parseFigmaLink(body?.designUrl);

    const client = supervisorClient(event);
    const inventory = await client.inventory();
    const candidates = inventory.arms.filter((arm) => arm.capabilities.includes(REQUIRED_CAPABILITY));

    if (candidates.length === 0) {
      throw new RelayError(
        'invalid_request',
        `no discovered arm declares ${REQUIRED_CAPABILITY} -- the studio reached the supervisor, ` +
          'but nothing on it can answer a chat',
      );
    }

    const armId = typeof body?.armId === 'string' && body.armId ? body.armId : candidates[0]?.id;
    const arm = candidates.find((entry) => entry.id === armId);
    if (!arm) {
      throw new RelayError('invalid_request', `"${armId}" is not an arm that declares ${REQUIRED_CAPABILITY}`);
    }

    const armParams = body?.armParams ?? {};
    // A rendering is only worth taking when a pass could actually be given it.
    const armReadsImages = String(armParams['vision'] ?? 'false') === 'true';

    const caller: ArmCaller = {
      job: (id, request) => client.job(id, request),
      progress: async (jobId) => (await client.progress(jobId)).job,
    };

    const run = createRun(analysisId, arm.id);

    try {
      return await analyse({
        storageDir: config.storageDir,
        analysisId,
        blockName,
        armId: arm.id,
        armParams,
        reference,
        ticket,
        design: new FigmaMcpSource(),
        caller,
        run,
        armReadsImages,
      });
    } catch (error) {
      // The run stays in the registry with its failed step, so the console's
      // next poll shows where it stopped rather than a bare 500.
      throw error instanceof RelayError
        ? error
        : new RelayError('arm_error', error instanceof Error ? error.message : String(error));
    } finally {
      // Keep the run readable for a while after it ends; a console that was
      // polling should see the final state rather than fall back to the record.
      setTimeout(() => forgetRun(analysisId), 60_000).unref?.();
    }
  });
});
