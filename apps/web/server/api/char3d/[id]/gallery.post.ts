import { addToGallery } from '../../../char3d/store';

/** Put a finished run (or one sheet of a ref run) in its step's gallery by hand: `{ run, set? }`. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = (await readBody<{ run?: unknown; set?: unknown }>(event)) ?? {};
  return { gallery: await addToGallery(config.storageDir, getRouterParam(event, 'id') ?? '', body) };
});
