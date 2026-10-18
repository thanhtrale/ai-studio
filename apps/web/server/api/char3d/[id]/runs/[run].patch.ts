import { patchRun } from '../../../../char3d/store';

/**
 * A review (`{ review: { score, verdict, criteria, summary, issues, improve, next?, picks? } }`)
 * or a corrected intent. Written after looking at the outputs; a pass puts the
 * run in its step's gallery, a later retry or fail takes it out again.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = (await readBody<Record<string, unknown>>(event)) ?? {};
  return patchRun(config.storageDir, getRouterParam(event, 'id') ?? '', getRouterParam(event, 'run') ?? '', body);
});
