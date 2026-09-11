import { listMedia } from '../../utils/library';

/**
 * The whole index, in one response.
 *
 * Paging would be premature: this is a single-user studio over one local
 * directory, and the library page wants every folder in the sidebar anyway.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return { items: await listMedia(config.storageDir) };
});
