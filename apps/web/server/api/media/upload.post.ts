import { writeFile } from 'node:fs/promises';

import { sanitiseUploadName } from '#shared/library';

import { allocateUploadId, describeMedia, ensureDirectoryFor, mediaPath, writeMeta } from '../../utils/library';
import { relay } from '../../utils/relay';

/**
 * h3 buffers a multipart body in memory, so this cap is a memory cap as much as
 * a policy one. Reference images are a megabyte or two; the headroom is for
 * video a user wants in the library beside what the arms produced.
 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);

  const declared = Number(getRequestHeader(event, 'content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: 'invalid_request',
      data: { message: `upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` },
    });
  }

  const parts = (await readMultipartFormData(event)) ?? [];
  const file = parts.find((part) => part.name === 'file' && part.filename !== undefined);
  if (!file) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: 'no file part in the upload' },
    });
  }

  if (file.data.byteLength > MAX_UPLOAD_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: 'invalid_request',
      data: { message: `upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` },
    });
  }

  const safe = sanitiseUploadName(file.filename ?? '');
  if (!safe) {
    throw createError({
      statusCode: 400,
      statusMessage: 'invalid_request',
      data: { message: `"${file.filename}" is not an image or video the studio can show` },
    });
  }

  return relay(async () => {
    // Uploads land in the arm input root: it is the only directory an arm is
    // allowed to read a conditioning image from, so anywhere else would make an
    // uploaded image unusable by the thing it was uploaded for.
    const id = await allocateUploadId(config.storageDir, safe.name);
    const target = mediaPath(config.storageDir, id);

    await ensureDirectoryFor(target);
    await writeFile(target, file.data);
    await writeMeta(config.storageDir, id, {
      source: 'uploaded',
      createdAt: new Date().toISOString(),
      originalName: file.filename ?? safe.name,
    });

    return { media: await describeMedia(config.storageDir, id) };
  });
});
