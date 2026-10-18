import { createCharacter } from '../../char3d/store';

/** A reference is a picture of one character; a few megabytes is plenty. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * A new character from a reference image.
 *
 * Multipart: `image` (the reference), `name` (as the person calls it), and the
 * English `subject`, `traits` and `style` every prompt is built from.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const declared = Number(getRequestHeader(event, 'content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'invalid_request', data: { message: 'reference too large' } });
  }
  const parts = (await readMultipartFormData(event)) ?? [];
  const field = (name: string): string => parts.find((part) => part.name === name)?.data.toString('utf8') ?? '';
  const image = parts.find((part) => part.name === 'image' && part.filename !== undefined);
  return createCharacter(config.storageDir, {
    name: field('name'),
    subject: field('subject'),
    traits: field('traits'),
    style: field('style'),
    image: image?.data ?? Buffer.alloc(0),
    ...(image?.filename ? { filename: image.filename } : {}),
  });
});
