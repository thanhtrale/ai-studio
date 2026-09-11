import { relay } from '../utils/relay';

/** Whole-card memory, sampled by the supervisor once a second for as long as it is up. */
export default defineEventHandler(async (event) => {
  const since = Number(getQuery(event)['since']);
  const client = supervisorClient(event);
  return relay(() => client.gpu(Number.isFinite(since) ? since : undefined));
});
