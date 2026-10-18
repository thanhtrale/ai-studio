import type { Char3dDetail } from '#shared/char3d';

import { galleryOf, getCharacter, listRuns } from '../../../char3d/store';

/** One character: its profile, every run, and the gallery each step offers the next. */
export default defineEventHandler(async (event): Promise<Char3dDetail> => {
  const config = useRuntimeConfig(event);
  const id = getRouterParam(event, 'id') ?? '';
  const character = await getCharacter(config.storageDir, id);
  const runs = await listRuns(config.storageDir, id);
  return { character, runs, gallery: await galleryOf(config.storageDir, character, runs) };
});
