import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { contentType, nameOf } from '#shared/library';

import { mediaPath } from '../../utils/library';
import { relay } from '../../utils/relay';

/** `bytes=start-end`, with either end optional. Anything else is ignored. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // A suffix range ("bytes=-500") asks for the last N bytes.
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/**
 * Serves one file out of the managed storage directory.
 *
 * Range requests are honoured because the library plays video inline, and a
 * browser will not seek -- nor reliably render a `#t=` thumbnail frame -- over a
 * response that answers 200 to every request.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const id = getQuery(event)['id'];

  const file = await relay(async () => mediaPath(config.storageDir, id));

  let stats;
  try {
    stats = await stat(file);
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'not_found', data: { message: `no media at ${id}` } });
  }

  setResponseHeaders(event, {
    'content-type': contentType(file),
    'accept-ranges': 'bytes',
    'content-disposition': `inline; filename="${nameOf(String(id))}"`,
    // The file at an id can be overwritten by a rerun of the same script, and a
    // cached thumbnail of the previous one is worse than a re-read.
    'cache-control': 'no-cache',
    'last-modified': stats.mtime.toUTCString(),
  });

  const header = getRequestHeader(event, 'range');
  const range = header ? parseRange(header, stats.size) : null;

  if (range) {
    setResponseStatus(event, 206);
    setResponseHeaders(event, {
      'content-range': `bytes ${range.start}-${range.end}/${stats.size}`,
      'content-length': range.end - range.start + 1,
    });
    return sendStream(event, createReadStream(file, { start: range.start, end: range.end }));
  }

  setResponseHeader(event, 'content-length', stats.size);
  return sendStream(event, createReadStream(file));
});
