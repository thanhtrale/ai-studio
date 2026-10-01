import type { SurveyResult } from '#shared/survey';

import { isSurveyId, readSurveyInventory, readSurveyRecord } from '../../../survey/store';

/**
 * What a survey found, as far as it has got.
 *
 * The index is written the moment the crawl ends rather than at the end of the
 * run, so this answers with a usable list while the renders and the model
 * passes are still happening. The console polls it during a run for exactly
 * that reason: a reader can start opening screens before the descriptions are
 * written.
 *
 * The inventory is absent, not an error, for a survey that failed in the crawl.
 * "It got this far" and "it never started" are different answers and the record
 * carries which.
 */
export default defineEventHandler(async (event): Promise<SurveyResult> => {
  const surveyId = getRouterParam(event, 'id');
  if (!isSurveyId(surveyId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  }

  const config = useRuntimeConfig(event);
  const record = await readSurveyRecord(config.storageDir, surveyId);
  if (!record) throw createError({ statusCode: 404, statusMessage: 'not_found' });

  const inventory = await readSurveyInventory(config.storageDir, surveyId);
  return inventory === undefined ? { record } : { record, inventory };
});
