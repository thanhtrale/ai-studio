/**
 * The animation review page's two sources.
 *
 * ```
 * storage/char3d-review/saved.json      rigged characters the person pressed Save on -- a REFERENCE to
 *                                        the rig run's rest.glb, not a copy (~57 MB each; runs are kept)
 * storage/models/rig/mixamo-lib/        the clip library, built by the rig arm's scripts/cliplib.py
 *   index.json  clips/<id>.glb  thumbs/<id>.gif
 * ```
 *
 * Clips are put on a character in the browser, by `mixamorig:*` bone name;
 * the retargeting rule and how it was checked against Blender are in
 * `Char3dAnimViewer.vue` and `cliplib.py`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createError } from 'h3';

import type { Char3dClipLibrary, Char3dReviewEntry } from '#shared/char3d';

import { charFile, getCharacter, getRun, safeId } from './store';

const savedFile = (storageDir: string): string => path.resolve(storageDir, 'char3d-review', 'saved.json');
export const clipLibraryDir = (storageDir: string): string => path.resolve(storageDir, 'models', 'rig', 'mixamo-lib');

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

async function readSaved(storageDir: string): Promise<Char3dReviewEntry[]> {
  try {
    return JSON.parse(await readFile(savedFile(storageDir), 'utf8')) as Char3dReviewEntry[];
  } catch {
    return [];
  }
}

async function writeSaved(storageDir: string, entries: Char3dReviewEntry[]): Promise<void> {
  await mkdir(path.dirname(savedFile(storageDir)), { recursive: true });
  await writeFile(savedFile(storageDir), JSON.stringify(entries, null, 1), 'utf8');
}

export async function listSaved(storageDir: string): Promise<Char3dReviewEntry[]> {
  return (await readSaved(storageDir)).map((entry) => {
    let missing = true;
    try {
      missing = !existsSync(charFile(storageDir, entry.character, entry.model));
    } catch {
      // A malformed entry reads as missing rather than taking the list down.
    }
    return { ...entry, missing };
  });
}

/** Save a finished rig run. Saving the same run again only renames it. */
export async function saveForReview(
  storageDir: string,
  body: { character?: unknown; run?: unknown; name?: unknown },
): Promise<Char3dReviewEntry> {
  const characterId = safeId(body.character);
  const runId = safeId(body.run);
  const character = await getCharacter(storageDir, characterId);
  const run = await getRun(storageDir, characterId, runId);
  if (run.step !== 'rig' || run.status !== 'done') bad('only a finished rig run can be saved');
  const model = `runs/${runId}/rig/rest.glb`;
  if (!existsSync(charFile(storageDir, characterId, model))) bad('the run has no rest.glb');

  // The picture of the MESH run the rig used (`config.mesh` = runs/<mesh>/mesh.glb).
  const meshDir = String(run.config['mesh'] ?? '').replace(/\/[^/]*$/, '');
  let thumb: string | undefined;
  for (const candidate of [meshDir && `${meshDir}/renders/tex_045.png`, meshDir && `${meshDir}/renders/tex_000.png`, character.ref]) {
    if (candidate && existsSync(charFile(storageDir, characterId, candidate))) {
      thumb = candidate;
      break;
    }
  }

  const id = `${characterId}-${runId}`;
  const all = await readSaved(storageDir);
  const previous = all.find((entry) => entry.id === id);
  const entry: Char3dReviewEntry = {
    id,
    name: String(body.name ?? '').trim() || `${character.name} · ${runId}`,
    character: characterId,
    run: runId,
    model,
    ...(thumb ? { thumb } : {}),
    savedAt: previous?.savedAt ?? Date.now(),
  };
  await writeSaved(storageDir, [entry, ...all.filter((other) => other.id !== id)]);
  return entry;
}

export async function deleteSaved(storageDir: string, id: string): Promise<void> {
  await writeSaved(storageDir, (await readSaved(storageDir)).filter((entry) => entry.id !== id));
}

// --- the clip library --------------------------------------------------------------

let cache: { file: string; mtime: number; data: Char3dClipLibrary } | null = null;

/** `index.json`, re-read when it changes: `cliplib.py index` may be running while the page is open. */
export async function clipLibrary(storageDir: string): Promise<Char3dClipLibrary> {
  const file = path.join(clipLibraryDir(storageDir), 'index.json');
  if (!existsSync(file)) return { clips: [], tagGroups: {}, groupOrder: [] };
  const mtime = (await stat(file)).mtimeMs;
  if (!cache || cache.file !== file || cache.mtime !== mtime) {
    cache = { file, mtime, data: JSON.parse(await readFile(file, 'utf8')) as Char3dClipLibrary };
  }
  return cache.data;
}

/** One clip's GLB or gif. The id is `[a-z0-9-]` only, so it cannot leave the library. */
export function clipFile(storageDir: string, id: string, kind: string): { file: string; type: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) bad('bad clip id');
  if (kind === 'clip') return { file: path.join(clipLibraryDir(storageDir), 'clips', `${id}.glb`), type: 'model/gltf-binary' };
  if (kind === 'thumb') return { file: path.join(clipLibraryDir(storageDir), 'thumbs', `${id}.gif`), type: 'image/gif' };
  bad('kind must be clip or thumb');
}
