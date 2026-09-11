import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  LIBRARY_DIR,
  MEDIA_ROOTS,
  UPLOAD_ROOT,
  extensionOf,
  groupOf,
  isMediaId,
  mediaKind,
  nameOf,
  recordId,
  type MediaItem,
  type MediaMeta,
} from '#shared/library';

import { RelayError } from './supervisor';

/** A runaway symlink or a deep scratch tree should not turn a page load into a crawl. */
const MAX_DEPTH = 6;

/**
 * Resolves a media id to a file, and refuses anything that is not one.
 *
 * The id is validated as a whitelist first (`isMediaId`) and the resolved path
 * is then checked against the storage root anyway. The second check is not
 * redundant: it is the one that still holds if the first ever gains a case it
 * did not anticipate, and this function is what stands between a query string
 * and the filesystem.
 */
export function mediaPath(storageDir: string, id: unknown): string {
  if (!isMediaId(id)) throw new RelayError('invalid_request', `"${String(id)}" is not a media id`);

  const root = path.resolve(storageDir);
  const resolved = path.resolve(root, id);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RelayError('invalid_request', `"${id}" resolves outside the storage directory`);
  }

  return resolved;
}

function recordPath(storageDir: string, id: string): string {
  return path.resolve(storageDir, recordId(id));
}

export async function readMeta(storageDir: string, id: string): Promise<MediaMeta | undefined> {
  try {
    const raw = await readFile(recordPath(storageDir, id), 'utf8');
    return JSON.parse(raw) as MediaMeta;
  } catch {
    // No record, or one that has been corrupted. Either way the file itself is
    // still real and still listable; the record is an annotation, not the truth.
    return undefined;
  }
}

export async function writeMeta(storageDir: string, id: string, meta: MediaMeta): Promise<void> {
  const target = recordPath(storageDir, id);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

async function walk(absolute: string, prefix: string, depth: number, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return; // A root that does not exist yet is an empty root, not an error.
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const id = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(path.join(absolute, entry.name), id, depth + 1, found);
      continue;
    }
    if (entry.isFile() && mediaKind(entry.name) !== null) found.push(id);
  }
}

async function describe(storageDir: string, id: string): Promise<MediaItem | null> {
  let stats;
  try {
    stats = await stat(path.resolve(storageDir, id));
  } catch {
    return null;
  }

  const meta = await readMeta(storageDir, id);

  return {
    id,
    name: nameOf(id),
    kind: mediaKind(id) ?? 'image',
    group: groupOf(id),
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    ...(meta ? { meta } : {}),
  };
}

/**
 * Everything under the scanned roots, whoever put it there.
 *
 * The filesystem is the index. A clip a benchmark script wrote appears here with
 * no registration step, which is the point: the library is a view of storage,
 * not a second place where things have to be remembered.
 */
export async function listMedia(storageDir: string): Promise<MediaItem[]> {
  const ids: string[] = [];
  for (const root of MEDIA_ROOTS) {
    await walk(path.resolve(storageDir, root), root, 1, ids);
  }

  const items = await Promise.all(ids.map((id) => describe(storageDir, id)));
  return items.filter((item): item is MediaItem => item !== null);
}

export async function describeMedia(storageDir: string, id: string): Promise<MediaItem | null> {
  mediaPath(storageDir, id);
  return describe(storageDir, id);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A free id for an upload, keeping the name the file arrived with.
 *
 * Uploading `frame.png` twice gives `frame.png` and `frame-2.png` rather than
 * one file silently replacing the other -- a reference image is pointed at by
 * records that were already written, so overwriting one rewrites history.
 */
export async function allocateUploadId(storageDir: string, fileName: string): Promise<string> {
  const ext = extensionOf(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);

  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const id = `${UPLOAD_ROOT}/${attempt === 1 ? stem : `${stem}-${attempt}`}${ext}`;
    if (!(await exists(mediaPath(storageDir, id)))) return id;
  }

  throw new RelayError('invalid_request', `too many files named "${stem}"`);
}

export async function ensureDirectoryFor(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
}

export { LIBRARY_DIR };
