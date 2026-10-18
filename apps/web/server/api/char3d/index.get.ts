import { listCharacters } from '../../char3d/store';

/** Every character, newest first, with its run count and last run. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return { characters: await listCharacters(config.storageDir) };
});
