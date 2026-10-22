import { startAuto } from '../../char3d/autopilot';
import { createCharacter, saveCharacter } from '../../char3d/store';
import { supervisorClient } from '../../utils/relay';

/** A reference is a picture of one character; a few megabytes is plenty. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * A new character from a reference image.
 *
 * Multipart: `image` (the reference), `name` (as the person calls it), and the
 * English `subject`, `traits` and `style` every prompt is built from.
 *
 * With `auto=true` the local vision model writes subject and traits itself and
 * the autopilot takes the character to a rig (`chibi`, default true, draws it
 * as a chibi figure whatever the reference's style). The name may then be left
 * out: the file's name stands in until the model reads one off the picture.
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
  const auto = field('auto') === 'true';
  const chibi = field('chibi') !== 'false';
  const fromFile = !field('name').trim() && auto;
  const character = await createCharacter(config.storageDir, {
    name: fromFile ? (image?.filename ?? 'character').replace(/\.[^.]*$/, '') || 'character' : field('name'),
    subject: field('subject'),
    traits: auto ? '' : field('traits'),
    style: field('style'),
    chibi,
    image: image?.data ?? Buffer.alloc(0),
    ...(image?.filename ? { filename: image.filename } : {}),
  });
  if (fromFile) {
    character.nameFromFile = true;
    await saveCharacter(config.storageDir, character);
  }
  if (auto) await startAuto(config.storageDir, supervisorClient(event), character.id, { chibi });
  return character;
});
