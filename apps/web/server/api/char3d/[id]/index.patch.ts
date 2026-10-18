import { patchCharacter } from '../../../char3d/store';

/** Edit the profile, append a note (`note`), or mark the best run of a step (`best`). */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const body = (await readBody<Record<string, unknown>>(event)) ?? {};
  return patchCharacter(config.storageDir, getRouterParam(event, 'id') ?? '', body);
});
