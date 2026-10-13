import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { relay } from '../../../../utils/relay';
import { DRAFT_FILES, draftDir, type DraftFile } from '../../../../utils/rig';

const TYPES: Record<DraftFile, string> = {
  'mesh.glb': 'model/gltf-binary',
  'rig.json': 'application/json',
  'weights.bin': 'application/octet-stream',
};

/** One of a rig draft's three files, for the editor. Nothing else in the folder is served. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const file = getRouterParam(event, 'file') as DraftFile;
  if (!DRAFT_FILES.includes(file)) {
    throw createError({ statusCode: 404, statusMessage: 'not_found', data: { message: 'not a draft file' } });
  }
  const folder = await relay(async () => draftDir(config.storageDir, getRouterParam(event, 'id') ?? ''));
  const absolute = path.join(folder, file);

  let size: number;
  try {
    size = (await stat(absolute)).size;
  } catch {
    throw createError({
      statusCode: 404,
      statusMessage: 'not_found',
      data: { message: 'this draft is gone -- detect the rig again' },
    });
  }
  setResponseHeaders(event, {
    'content-type': TYPES[file],
    'content-length': size,
    // A draft id is never reused for different content.
    'cache-control': 'private, max-age=3600',
  });
  return sendStream(event, createReadStream(absolute));
});
