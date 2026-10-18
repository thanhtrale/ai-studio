import { sendFile } from '../../../../char3d/send';
import { charFile } from '../../../../char3d/store';

/** One file of a character, by its path relative to the character's directory. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const rel = decodeURIComponent(getRouterParam(event, 'path') ?? '');
  return sendFile(event, charFile(config.storageDir, getRouterParam(event, 'id') ?? '', rel));
});
