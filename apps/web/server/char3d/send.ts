/**
 * Streaming one file of a character, or of the clip library, to the page.
 *
 * Range requests are honoured: a rigged GLB is tens of megabytes and the
 * viewer may fetch it in parts. The rule is the media route's.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { H3Event } from 'h3';
import { createError, getRequestHeader, sendStream, setResponseHeader, setResponseHeaders, setResponseStatus } from 'h3';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
  '.fbx': 'application/octet-stream',
  '.npz': 'application/octet-stream',
  '.pkl': 'application/octet-stream',
};

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

export async function sendFile(event: H3Event, file: string, type?: string): Promise<unknown> {
  let stats;
  try {
    stats = await stat(file);
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'not_found', data: { message: 'no such file' } });
  }
  if (!stats.isFile()) throw createError({ statusCode: 404, statusMessage: 'not_found' });

  const extension = path.extname(file).toLowerCase();
  setResponseHeaders(event, {
    'content-type': type ?? TYPES[extension] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    // A run's files are rewritten by a retexture or a re-review; never serve a stale one.
    'cache-control': 'no-cache',
    'last-modified': stats.mtime.toUTCString(),
    ...(extension === '.fbx' || extension === '.npz' || extension === '.pkl'
      ? { 'content-disposition': `attachment; filename="${path.basename(file)}"` }
      : {}),
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
}
