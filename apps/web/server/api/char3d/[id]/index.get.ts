import type { Char3dDetail } from '#shared/char3d';

import { readAuto } from '../../../char3d/autopilot';
import { galleryOf, getCharacter, listRuns } from '../../../char3d/store';

/** One character: its profile, every run, the gallery each step offers the next, and the autopilot's state. */
export default defineEventHandler(async (event): Promise<Char3dDetail> => {
  const config = useRuntimeConfig(event);
  const id = getRouterParam(event, 'id') ?? '';
  const character = await getCharacter(config.storageDir, id);
  const runs = await listRuns(config.storageDir, id);
  const auto = await readAuto(config.storageDir, id);
  return { character, runs, gallery: await galleryOf(config.storageDir, character, runs), ...(auto ? { auto } : {}) };
});
