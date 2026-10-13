import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { RigBoneEdits, RigDraftInfo } from '#shared/generate';
import { isMediaId, mediaKind, rootOf, UPLOAD_ROOT } from '#shared/library';

import { ensureDirectoryFor, mediaPath } from './library';
import { RelayError } from './supervisor';

/** Where a generated file is copied to so an arm may read it -- the mesh route's folder. */
const STAGED_DIR = 'from-outputs';

/**
 * Where the rig arm writes drafts, under `outputs/`. A dot folder, so the
 * library -- which skips them -- never lists a draft as a result.
 */
export const DRAFTS_DIR = '.rig-drafts';
const DRAFT_ID = /^[A-Za-z0-9._-]{8,64}$/;
/** The files of a draft the editor may read. Nothing else in the folder is served. */
export const DRAFT_FILES = ['mesh.glb', 'rig.json', 'weights.bin'] as const;
export type DraftFile = (typeof DRAFT_FILES)[number];
export const EDITED_WEIGHTS = 'weights.edited.bin';
/** Drafts nobody approved are kept this long, then cleared when the next one is made. */
const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Four influences per vertex: four float32 weights and four uint8 bone indices. */
export const WEIGHT_BYTES_PER_VERTEX = 4 * 4 + 4;
/** In MIA's frame a body is about two units tall; past this a coordinate is a typo. */
const MAX_COORDINATE = 10;

export function isDraftId(id: unknown): id is string {
  return typeof id === 'string' && DRAFT_ID.test(id) && id !== '.' && id !== '..';
}

export function draftDir(storageDir: string, id: string): string {
  if (!isDraftId(id)) throw new RelayError('invalid_request', 'not a draft id');
  return path.join(storageDir, 'outputs', DRAFTS_DIR, id);
}

export async function readDraftInfo(storageDir: string, id: string): Promise<RigDraftInfo> {
  try {
    return JSON.parse(await readFile(path.join(draftDir(storageDir, id), 'rig.json'), 'utf8')) as RigDraftInfo;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('not_found', `no rig draft "${id}" -- detect the rig again`);
  }
}

/** Every draft older than a day: a person who walked away will not come back to it. */
export async function pruneDrafts(storageDir: string, now = Date.now()): Promise<void> {
  const root = path.join(storageDir, 'outputs', DRAFTS_DIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries.filter(isDraftId).map(async (entry) => {
      const folder = path.join(root, entry);
      try {
        if (now - (await stat(folder)).mtimeMs > DRAFT_LIFETIME_MS) await rm(folder, { recursive: true, force: true });
      } catch {
        // Gone already, or in use: either way not worth failing a new draft for.
      }
    }),
  );
}

/**
 * The mesh as an id under `inputs/`, copied there if it was generated.
 *
 * The usual input is a mesh this studio just made, and arms may only read
 * `inputs/` -- the same staging the mesh route does for photographs.
 */
export async function stageMesh(storageDir: string, id: unknown): Promise<string> {
  if (!isMediaId(id) || mediaKind(id) !== 'model') {
    throw new RelayError('invalid_request', 'the mesh must be a .glb in the library');
  }
  if (rootOf(id) === UPLOAD_ROOT) return id;

  const staged = `${UPLOAD_ROOT}/${STAGED_DIR}/${id.slice(id.indexOf('/') + 1)}`;
  if (!isMediaId(staged)) throw new RelayError('invalid_request', `${id} is nested too deeply to stage`);
  const target = mediaPath(storageDir, staged);
  try {
    await stat(target);
  } catch {
    await ensureDirectoryFor(target);
    await copyFile(mediaPath(storageDir, id), target);
  }
  return staged;
}

function isPoint(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE)
  );
}

/**
 * Bone edits checked against the draft they are for: known names, finite
 * points in range. The arm checks again; this is so a bad edit is refused
 * before Blender is brokered onto the card for it.
 */
export function checkBoneEdits(edits: unknown, info: RigDraftInfo): RigBoneEdits {
  if (edits === undefined || edits === null) return {};
  if (typeof edits !== 'object' || Array.isArray(edits)) {
    throw new RelayError('invalid_request', 'bones must map bone names to a head and a tail');
  }
  const known = new Set(info.bones.map((bone) => bone.name));
  const out: RigBoneEdits = {};
  for (const [name, edit] of Object.entries(edits as Record<string, unknown>)) {
    if (!known.has(name)) throw new RelayError('invalid_request', `"${name}" is not a bone of this rig`);
    const { head, tail } = (edit ?? {}) as { head?: unknown; tail?: unknown };
    if (!isPoint(head) || !isPoint(tail)) {
      throw new RelayError('invalid_request', `${name}: head and tail must be three numbers within ±${MAX_COORDINATE}`);
    }
    out[name] = { head, tail };
  }
  return out;
}
