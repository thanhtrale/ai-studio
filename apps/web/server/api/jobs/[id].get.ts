import { relay } from '../../utils/relay';

/**
 * A job's timeline while it is still running.
 *
 * Polled rather than pushed: three processes are involved and a job is minutes
 * long, so a dropped stream would have to be re-established anyway. `since`
 * trims the VRAM series to what the caller has not already drawn.
 */
export default defineEventHandler(async (event) => {
  const jobId = getRouterParam(event, 'id');
  if (!jobId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const since = Number(getQuery(event)['since']);
  const client = supervisorClient(event);
  return relay(() => client.progress(jobId, Number.isFinite(since) ? since : undefined));
});
