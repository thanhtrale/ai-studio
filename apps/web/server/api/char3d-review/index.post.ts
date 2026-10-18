import { saveForReview } from '../../char3d/review';

/** Save a finished rig run to the review list: `{ character, run, name? }`. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = (await readBody<{ character?: unknown; run?: unknown; name?: unknown }>(event)) ?? {};
  return saveForReview(config.storageDir, body);
});
