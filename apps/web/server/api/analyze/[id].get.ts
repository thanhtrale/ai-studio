import type { GpuTelemetry, JobProgressResponse } from '@ai-studio/arm-contract';

import { getRun, progressFromRecord } from '../../analysis/registry';
import { isAnalysisId, readRecord } from '../../analysis/store';
import { supervisorClient } from '../../utils/relay';

/** What the chart draws when the supervisor cannot be asked. */
const NO_GPU: GpuTelemetry = { totalGib: null, available: false, samples: [] };

/**
 * An analysis's timeline while it is still running.
 *
 * The same shape the job route returns, so the console's telemetry composable
 * and its timeline component drive an analysis without knowing it is not a
 * generation. `since` trims the machine's VRAM series to what the caller has
 * not already drawn.
 *
 * Two sources, in this order: the registry for a run in flight, then the record
 * on disk for one that is not. The second is not a fallback for convenience --
 * it is what stops a run killed by a reload from being reported as running for
 * ever.
 */
export default defineEventHandler(async (event): Promise<JobProgressResponse> => {
  const analysisId = getRouterParam(event, 'id');
  if (!isAnalysisId(analysisId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  }

  const since = Number(getQuery(event)['since']);

  // The machine meter runs whether or not an analysis does, and a supervisor
  // that is down must not stop an analysis reporting its own steps: the passes
  // need it, the timeline does not.
  const gpu = await supervisorClient(event)
    .gpu(Number.isFinite(since) ? since : undefined)
    .catch(() => NO_GPU);

  const run = getRun(analysisId);
  if (run) return { job: run.progress(), gpu };

  const config = useRuntimeConfig(event);
  const record = await readRecord(config.storageDir, analysisId);
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: 'not_found' });
  }

  return { job: progressFromRecord(record), gpu };
});
