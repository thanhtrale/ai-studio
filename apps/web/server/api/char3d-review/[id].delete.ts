import { deleteSaved } from '../../char3d/review';

/** Off the review list. The rig run and its files are kept. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  await deleteSaved(config.storageDir, getRouterParam(event, 'id') ?? '');
  return { ok: true };
});
