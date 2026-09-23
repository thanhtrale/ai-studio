import { rm } from 'node:fs/promises';

import { inboxPath } from '../../utils/lan';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const file = inboxPath(config.storageDir, getQuery(event)['name']);
  if (!file) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  await rm(file, { force: true });
  return { ok: true };
});
