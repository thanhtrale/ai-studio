import { rm } from 'node:fs/promises';

import { relay } from '../../../utils/relay';
import { draftDir } from '../../../utils/rig';

/** Throw a draft away: the editor's Discard. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return relay(async () => {
    await rm(draftDir(config.storageDir, getRouterParam(event, 'id') ?? ''), { recursive: true, force: true });
    return { ok: true };
  });
});
