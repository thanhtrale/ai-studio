/**
 * Where a 3D character lives on disk.
 *
 * ```
 * storage/char3d/<character>/
 *   character.json        the profile, the gallery, and notes learnt on this character
 *   ref.<ext>             the original reference the person gave
 *   runs/<rNN-step>/
 *     run.json            ONE run of ONE step: config, outputs, timing, review
 *     ...                 that run's files
 * ```
 *
 * One run is one step, never the whole chain, because every step is looked at
 * and scored before the next one uses it: a sheet that is not good enough is
 * generated again, not pushed on to a mesh. A run records `parent`, the run it
 * took its input from, so the chain reads backwards: rig r07 <- mesh r05 <- ref r03.
 *
 * Not the media library. Arms read from `inputs/` and write to `outputs/`, so
 * the runner stages a run's inputs under `inputs/.char3d/` and moves what an
 * arm wrote out of `outputs/.char3d/` into the run's directory; the library
 * skips dot folders, so neither staging tree is listed as media.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createError } from 'h3';

import {
  CHAR3D_ID,
  CHAR3D_VIEWS,
  type Char3dCharacter,
  type Char3dCharacterSummary,
  type Char3dGalleryItem,
  type Char3dReview,
  type Char3dRun,
  type Char3dSheetSet,
  type Char3dStep,
  type Char3dView,
  slugFor,
} from '#shared/char3d';

export const CHAR3D_DIR = 'char3d';
const REF_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

function bad(message: string): never {
  throw createError({ statusCode: 400, statusMessage: 'invalid_request', data: { message } });
}

function missing(message: string): never {
  throw createError({ statusCode: 404, statusMessage: 'not_found', data: { message } });
}

export function safeId(value: unknown): string {
  const id = String(value ?? '');
  if (!CHAR3D_ID.test(id)) bad(`"${id}" is not a character or run id`);
  return id;
}

export const rootOf = (storageDir: string): string => path.resolve(storageDir, CHAR3D_DIR);
export const charDir = (storageDir: string, id: string): string => path.join(rootOf(storageDir), safeId(id));
export const runDir = (storageDir: string, id: string, run: string): string =>
  path.join(charDir(storageDir, id), 'runs', safeId(run));

/** A file in a character's directory, by a path relative to it. Never outside it. */
export function charFile(storageDir: string, id: string, rel: string): string {
  const base = charDir(storageDir, id);
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || path.isAbsolute(rel)) bad('bad path');
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base + path.sep)) bad('bad path');
  return resolved;
}

/** A path relative to the character's directory, with forward slashes -- what run.json and the page carry. */
export function relOf(storageDir: string, id: string, absolute: string): string {
  const base = charDir(storageDir, id) + path.sep;
  const normalised = path.resolve(absolute);
  if (!normalised.startsWith(base)) throw new Error(`${absolute} is not inside ${base}`);
  return normalised.slice(base.length).split(path.sep).join('/');
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Written whole, then renamed over the old one, so a reader never sees half a record.
 *
 * On Windows a rename onto a file someone has open fails with EPERM or EBUSY
 * -- and the page polls run.json while the runner writes it. So the rename is
 * retried for a moment before giving up on atomicity and writing in place: a
 * run must not fail because its record was being read.
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 1);
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temp, text, 'utf8');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await writeFile(file, text, 'utf8');
  await rm(temp, { force: true });
}

// --- liveness ---------------------------------------------------------------

/**
 * Runs this server process is working on, by `<character>/<run>`.
 *
 * Module state, and that is the point: a run whose record says queued or
 * running but which is not in here was interrupted -- the web server restarted
 * under it, which in development is every edit to `server/`. It is reported as
 * such rather than as a spinner that never stops.
 */
const live = new Set<string>();
export const liveKey = (id: string, run: string): string => `${id}/${run}`;
export const markLive = (id: string, run: string): void => void live.add(liveKey(id, run));
export const markDone = (id: string, run: string): void => void live.delete(liveKey(id, run));

function withLiveness(id: string, run: Char3dRun): Char3dRun {
  if ((run.status === 'queued' || run.status === 'running') && !live.has(liveKey(id, run.id))) {
    return { ...run, status: 'error', error: 'interrupted: the web server restarted while this run was queued or running' };
  }
  return run;
}

// --- characters ---------------------------------------------------------------

export async function listCharacters(storageDir: string): Promise<Char3dCharacterSummary[]> {
  const root = rootOf(storageDir);
  if (!existsSync(root)) return [];
  const out: Char3dCharacterSummary[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !CHAR3D_ID.test(entry.name)) continue;
    const character = await readJson<Char3dCharacter>(path.join(root, entry.name, 'character.json'));
    if (!character) continue;
    const runs = await listRuns(storageDir, character.id);
    out.push({ ...character, runs: runs.length, ...(runs.length ? { lastRun: runs.at(-1) } : {}) });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCharacter(storageDir: string, id: string): Promise<Char3dCharacter> {
  const character = await readJson<Char3dCharacter>(path.join(charDir(storageDir, id), 'character.json'));
  if (!character) missing(`no character "${id}"`);
  return character;
}

export async function saveCharacter(storageDir: string, character: Char3dCharacter): Promise<void> {
  await writeJson(path.join(charDir(storageDir, character.id), 'character.json'), character);
}

export interface NewCharacter {
  name: string;
  subject?: string;
  traits?: string;
  style?: string;
  chibi?: boolean;
  image: Buffer;
  filename?: string;
}

export async function createCharacter(storageDir: string, body: NewCharacter): Promise<Char3dCharacter> {
  const name = String(body.name ?? '').trim();
  if (!name) bad('name is required');
  if (!body.image?.length) bad('a reference image is required');
  const extension = path.extname(body.filename ?? '').toLowerCase() || '.png';
  if (!REF_EXTENSIONS.includes(extension)) bad('the reference must be png, jpg or webp');

  const slug = slugFor(name);
  let id = slug;
  for (let index = 2; existsSync(path.join(rootOf(storageDir), id)); index += 1) id = `${slug}-${index}`;

  const character: Char3dCharacter = {
    id,
    name,
    subject: String(body.subject ?? '').trim() || 'character',
    traits: String(body.traits ?? '').trim(),
    style: String(body.style ?? '').trim() || 'chibi',
    ...(body.chibi !== undefined ? { chibi: body.chibi } : {}),
    ref: `ref${extension}`,
    createdAt: Date.now(),
    notes: [],
  };
  await mkdir(path.join(charDir(storageDir, id), 'runs'), { recursive: true });
  await writeFile(path.join(charDir(storageDir, id), character.ref), body.image);
  await saveCharacter(storageDir, character);
  return character;
}

export async function patchCharacter(
  storageDir: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Char3dCharacter> {
  const character = await getCharacter(storageDir, id);
  for (const key of ['name', 'subject', 'traits', 'style'] as const) {
    if (typeof body[key] === 'string') character[key] = body[key].trim();
  }
  if (typeof body['chibi'] === 'boolean') character.chibi = body['chibi'];
  if (typeof body['note'] === 'string' && body['note'].trim()) {
    (character.notes ??= []).push({ at: Date.now(), text: body['note'].trim() });
  }
  if (body['best'] && typeof body['best'] === 'object') {
    character.best = { ...character.best, ...(body['best'] as Partial<Record<Char3dStep, string>>) };
  }
  await saveCharacter(storageDir, character);
  return character;
}

// --- runs ---------------------------------------------------------------------

export async function listRuns(storageDir: string, id: string): Promise<Char3dRun[]> {
  const dir = path.join(charDir(storageDir, id), 'runs');
  if (!existsSync(dir)) return [];
  const out: Char3dRun[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !CHAR3D_ID.test(entry.name)) continue;
    const run = await readJson<Char3dRun>(path.join(dir, entry.name, 'run.json'));
    if (run) out.push(withLiveness(id, run));
  }
  return out.sort((a, b) => a.n - b.n);
}

export async function getRun(storageDir: string, id: string, run: string): Promise<Char3dRun> {
  const record = await readJson<Char3dRun>(path.join(runDir(storageDir, id, run), 'run.json'));
  if (!record) missing(`no run "${run}"`);
  return withLiveness(id, record);
}

export async function saveRun(storageDir: string, id: string, run: Char3dRun): Promise<void> {
  await writeJson(path.join(runDir(storageDir, id, run.id), 'run.json'), run);
}

export async function nextRunId(storageDir: string, id: string, step: Char3dStep): Promise<{ id: string; n: number }> {
  const n = (await listRuns(storageDir, id)).reduce((max, run) => Math.max(max, run.n), 0) + 1;
  return { id: `r${String(n).padStart(2, '0')}-${step}`, n };
}

const clamp = (value: unknown, low: number, high: number): number =>
  Math.max(low, Math.min(high, Number(value) || 0));

function parseReview(raw: Record<string, unknown>): Char3dReview {
  const verdict = raw['verdict'];
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  return {
    at: Date.now(),
    by: String(raw['by'] || 'user'),
    score: clamp(raw['score'], 0, 100),
    verdict: verdict === 'pass' || verdict === 'fail' ? verdict : 'retry',
    criteria: Array.isArray(raw['criteria'])
      ? raw['criteria'].map((criterion: Record<string, unknown>) => ({
          key: String(criterion['key']),
          label: String(criterion['label'] ?? criterion['key']),
          score: clamp(criterion['score'], 0, 10),
          ...(criterion['note'] ? { note: String(criterion['note']) } : {}),
        }))
      : [],
    summary: String(raw['summary'] ?? ''),
    issues: list(raw['issues']),
    improve: list(raw['improve']),
    ...(raw['next'] ? { next: String(raw['next']) } : {}),
    ...(raw['picks'] && typeof raw['picks'] === 'object'
      ? { picks: raw['picks'] as Partial<Record<Char3dView, string>> }
      : {}),
  };
}

/** A review, written after looking at the outputs. Never by the runner. */
export async function patchRun(
  storageDir: string,
  id: string,
  runId: string,
  body: Record<string, unknown>,
): Promise<Char3dRun> {
  const run = await getRun(storageDir, id, runId);
  if (body['review'] && typeof body['review'] === 'object') {
    run.review = parseReview(body['review'] as Record<string, unknown>);
  }
  if (typeof body['intent'] === 'string') run.intent = body['intent'];
  await saveRun(storageDir, id, run);
  if (run.review) await syncGalleryWithReview(storageDir, id, run);
  return run;
}

// --- gallery ------------------------------------------------------------------

const sheetSets = (run: Char3dRun): Char3dSheetSet[] => (run.outputs?.['sets'] ?? []) as Char3dSheetSet[];

/** The views of a ref item: sheet `set` of the run, or the review's picks for a run of separate views. */
function refViews(run: Char3dRun, set?: number): Partial<Record<Char3dView, string>> | undefined {
  if (set !== undefined) return sheetSets(run).find((entry) => entry.index === set)?.views ?? undefined;
  return run.review?.picks;
}

/**
 * What a passing ref run puts in the gallery: the sheet its picks name; with
 * no picks, every sheet that passed the cross-check; a run of separate views,
 * its picks.
 */
function refItemsFromReview(run: Char3dRun): Omit<Char3dGalleryItem, 'at' | 'by'>[] {
  const sets = sheetSets(run);
  const picks = run.review?.picks;
  if (sets.length) {
    const hit = picks && sets.find((entry) => entry.views && entry.views.front === picks.front);
    if (hit) return [{ step: 'ref', run: run.id, set: hit.index, ...(hit.views ? { views: hit.views } : {}) }];
    if (!picks) {
      return sets
        .filter((entry) => entry.views && entry.check?.ok)
        .map((entry) => ({ step: 'ref' as const, run: run.id, set: entry.index, views: entry.views ?? {} }));
    }
  }
  return picks?.front ? [{ step: 'ref', run: run.id, views: picks }] : [];
}

/** The character's gallery. A record from before the field existed is rebuilt from its passing runs. */
export async function galleryOf(
  storageDir: string,
  character: Char3dCharacter,
  runs?: Char3dRun[],
): Promise<Char3dGalleryItem[]> {
  if (character.gallery) return character.gallery;
  const out: Char3dGalleryItem[] = [];
  for (const run of runs ?? (await listRuns(storageDir, character.id))) {
    if (run.review?.verdict !== 'pass' || run.status !== 'done') continue;
    if (run.step === 'ref') {
      for (const item of refItemsFromReview(run)) out.push({ ...item, at: run.review.at, by: 'review' });
    } else out.push({ step: run.step, run: run.id, at: run.review.at, by: 'review' });
  }
  return out;
}

const sameItem = (a: { run: string; set?: number }, b: { run: string; set?: number }): boolean =>
  a.run === b.run && (a.set ?? -1) === (b.set ?? -1);

async function syncGalleryWithReview(storageDir: string, id: string, run: Char3dRun): Promise<void> {
  const character = await getCharacter(storageDir, id);
  let gallery = await galleryOf(storageDir, character);
  if (run.review?.verdict === 'pass' && run.status === 'done') {
    const items = run.step === 'ref' ? refItemsFromReview(run) : [{ step: run.step, run: run.id }];
    for (const item of items) {
      if (!gallery.some((existing) => sameItem(existing, item))) {
        gallery = [...gallery, { ...item, at: Date.now(), by: 'review' as const }];
      }
    }
  } else {
    // A later retry or fail takes out what a review put in. What the person
    // added by hand stays: they are the one who decides.
    gallery = gallery.filter((item) => item.run !== run.id || item.by === 'user');
  }
  character.gallery = gallery;
  await saveCharacter(storageDir, character);
}

const setOf = (value: unknown): number | undefined =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

export async function addToGallery(
  storageDir: string,
  id: string,
  body: { run?: unknown; set?: unknown },
): Promise<Char3dGalleryItem[]> {
  const character = await getCharacter(storageDir, id);
  const run = await getRun(storageDir, id, safeId(body.run));
  if (run.status !== 'done') bad('only a finished run can go into the gallery');
  const set = setOf(body.set);
  let views: Char3dGalleryItem['views'];
  if (run.step === 'ref') {
    views = refViews(run, set);
    if (!views?.front) bad(set === undefined ? 'pick a sheet of this ref run' : `sheet ${set} has no usable views`);
  }
  const gallery = (await galleryOf(storageDir, character)).filter((item) => !sameItem(item, { run: run.id, set }));
  character.gallery = [
    ...gallery,
    {
      step: run.step,
      run: run.id,
      ...(set !== undefined ? { set } : {}),
      ...(views ? { views } : {}),
      at: Date.now(),
      by: 'user',
    },
  ];
  await saveCharacter(storageDir, character);
  return character.gallery;
}

export async function removeFromGallery(
  storageDir: string,
  id: string,
  body: { run?: unknown; set?: unknown },
): Promise<Char3dGalleryItem[]> {
  const character = await getCharacter(storageDir, id);
  const set = setOf(body.set);
  character.gallery = (await galleryOf(storageDir, character)).filter(
    (item) => !sameItem(item, { run: String(body.run ?? ''), set }),
  );
  await saveCharacter(storageDir, character);
  return character.gallery;
}

export const isView = (value: string): value is Char3dView => (CHAR3D_VIEWS as readonly string[]).includes(value);
