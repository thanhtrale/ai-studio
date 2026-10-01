import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { isSurveyId, surveyArtifactPath } from '../../../survey/store';
import { relay } from '../../../utils/relay';

/**
 * One render out of a survey.
 *
 * Named rather than pathed: the browser passes the artefact name the inventory
 * gave it, and the store refuses anything that is not one directory and a plain
 * filename. These are not media library entries -- they are pictures of
 * somebody else's design file, and the library is for what this studio made.
 */
export default defineEventHandler(async (event) => {
  const surveyId = getRouterParam(event, 'id');
  if (!isSurveyId(surveyId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  }

  const config = useRuntimeConfig(event);
  const name = String(getQuery(event)['name'] ?? '');

  const file = await relay(async () => surveyArtifactPath(config.storageDir, surveyId, name));

  let stats;
  try {
    stats = await stat(file);
  } catch {
    throw createError({
      statusCode: 404,
      statusMessage: 'not_found',
      data: { message: `this survey has no ${name}` },
    });
  }

  setResponseHeaders(event, {
    'content-type': 'image/png',
    'content-length': stats.size,
    // A rerun of the same survey id would overwrite these, and a cached render
    // of the previous crawl is worse than a re-read.
    'cache-control': 'no-cache',
    'last-modified': stats.mtime.toUTCString(),
  });

  return sendStream(event, createReadStream(file));
});
