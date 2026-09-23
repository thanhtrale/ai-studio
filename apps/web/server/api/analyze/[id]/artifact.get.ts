import { modelFileName } from '../../../analysis/pipeline/analyse';
import { GAPS_FILE, REQUIREMENTS_FILE, isAnalysisId, readArtifact, readRecord } from '../../../analysis/store';

/**
 * One artefact of a finished analysis.
 *
 * Named by a short key rather than by a filename, so the browser never supplies
 * a path: the model's filename is derived from the block name here, on the
 * server, and `requirements` and `gaps` are fixed.
 */
export default defineEventHandler(async (event) => {
  const analysisId = getRouterParam(event, 'id');
  if (!isAnalysisId(analysisId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid_request' });
  }

  const config = useRuntimeConfig(event);
  const wanted = String(getQuery(event)['name'] ?? 'requirements');

  const record = await readRecord(config.storageDir, analysisId);
  if (!record) throw createError({ statusCode: 404, statusMessage: 'not_found' });

  const names: Record<string, { file: string; type: string; download: string }> = {
    requirements: { file: REQUIREMENTS_FILE, type: 'text/markdown', download: REQUIREMENTS_FILE },
    gaps: { file: GAPS_FILE, type: 'application/json', download: GAPS_FILE },
    model: {
      file: modelFileName(record.blockName),
      type: 'application/json',
      download: modelFileName(record.blockName),
    },
  };

  const target = names[wanted];
  if (!target) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: `"${wanted}" is not an artefact of an analysis` },
    });
  }

  const contents = await readArtifact(config.storageDir, analysisId, target.file);
  if (contents === undefined) {
    throw createError({
      statusCode: 404,
      statusMessage: 'not_found',
      data: { message: `this analysis has no ${wanted} -- it may not have got that far` },
    });
  }

  setResponseHeader(event, 'content-type', `${target.type}; charset=utf-8`);
  return contents;
});
