import { deleteSurvey, isSurveyId, readSurveyRecord } from '../../survey/store';
import { forgetSurveyRun, getSurveyRun } from '../../survey/run';
import { relay } from '../../utils/relay';

/**
 * Forgets a survey and everything it wrote.
 *
 * A survey of a large file is a directory of renders, and a list nobody can
 * prune is a list that becomes unusable. A run still in flight is refused
 * rather than deleted underneath itself.
 */
export default defineEventHandler(async (event) => {
  const surveyId = getRouterParam(event, 'id');
  if (!isSurveyId(surveyId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  }

  const config = useRuntimeConfig(event);
  const record = await readSurveyRecord(config.storageDir, surveyId);
  if (!record) throw createError({ statusCode: 404, statusMessage: 'not_found' });

  if (getSurveyRun(surveyId)?.state === 'running') {
    throw createError({
      statusCode: 409,
      statusMessage: 'invalid_request',
      data: { message: 'that survey is still running' },
    });
  }

  await relay(async () => deleteSurvey(config.storageDir, surveyId));
  forgetSurveyRun(surveyId);
  return { surveyId, deleted: true };
});
