import { createRun, type NewRun } from '../../../../char3d/runner';
import { supervisorClient } from '../../../../utils/relay';

/**
 * A new run of one step: `{ step, parent?, intent?, config }`.
 *
 * Answers as soon as the run is recorded and queued -- a mesh is minutes --
 * and the page follows it by polling the character and the run's own jobs.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = (await readBody<NewRun & { step?: unknown }>(event)) ?? {};
  const client = supervisorClient(event);
  // The client outlives this request: the run carries on after the answer.
  return createRun(config.storageDir, client, getRouterParam(event, 'id') ?? '', body.step, body);
});
