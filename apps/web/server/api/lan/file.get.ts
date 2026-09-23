import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { inboxPath } from '../../utils/lan';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const name = getQuery(event)['name'];
  const file = inboxPath(config.storageDir, name);

  const stats = file ? await stat(file).catch(() => null) : null;
  if (!file || !stats?.isFile()) {
    throw createError({ statusCode: 404, statusMessage: 'not_found', data: { message: `no file ${name}` } });
  }

  setResponseHeaders(event, {
    'content-type': 'application/octet-stream',
    'content-length': stats.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(name))}`,
  });
  return sendStream(event, createReadStream(file));
});
