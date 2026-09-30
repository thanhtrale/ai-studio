import type { GpuTelemetry, JobProgressResponse } from '@ai-studio/arm-contract';

import { getSurveyRun, surveyProgressFromRecord } from '../../survey/run';
import { isSurveyId, readSurveyRecord } from '../../survey/store';
import { supervisorClient } from '../../utils/relay';

/** What the chart draws when the supervisor cannot be asked. */
const NO_GPU: GpuTelemetry = { totalGib: null, available: false, samples: [] };

/**
 * A survey's timeline.
 *
 * The same shape the job and analysis routes return, so the console's telemetry
 * composable and timeline drive a survey without knowing it is neither a
 * generation nor an analysis.
 *
 * Two sources, in this order: the registry for a run in flight, then the record
 * on disk. The second is what stops a run killed by a reload from being
 * reported as running for ever.
 */
export default defineEventHandler(async (event): Promise<JobProgressResponse> => {
  const surveyId = getRouterParam(event, 'id');
  if (!isSurveyId(surveyId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  }

  const since = Number(getQuery(event)['since']);

  const gpu = await supervisorClient(event)
    .gpu(Number.isFinite(since) ? since : undefined)
    .catch(() => NO_GPU);

  const run = getSurveyRun(surveyId);
  if (run) return { job: run.progress(), gpu };

  const config = useRuntimeConfig(event);
  const record = await readSurveyRecord(config.storageDir, surveyId);
  if (!record) throw createError({ statusCode: 404, statusMessage: 'not_found' });

  return { job: surveyProgressFromRecord(record), gpu };
});
