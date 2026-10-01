/**
 * Where a survey lives on disk.
 *
 * ```
 * storage/surveys/<id>/
 *   survey.json        state, file, options, timings, counts
 *   inventory.json     pages, screens, components, modules
 *   shots/<node>.png   one render per frame, named by node id
 * ```
 *
 * `inventory.json` is written as soon as the crawl finishes rather than at the
 * end of the run. The crawl is the part that produces the list; the model
 * passes only annotate it. Writing early means a survey whose model passes fail
 * -- or whose process is restarted mid-run, which in development is every edit
 * -- still leaves a usable index behind, and it is what lets the console show
 * the components while the descriptions are still being written.
 *
 * The renders are not media library entries. The library's kinds are image and
 * video produced by this studio; these are references to somebody else's
 * design, and putting them in the library would mean a search for "hero" returns
 * screenshots of a Figma file alongside generated art.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SurveyInventory, SurveyRecord } from '#shared/survey';

import { RelayError } from '../utils/supervisor';

export const SURVEYS_DIR = 'surveys';

export const SURVEY_FILE = 'survey.json';
export const INVENTORY_FILE = 'inventory.json';
export const SHOTS_DIR = 'shots';

/**
 * A survey id is a job id with room for a suffix.
 *
 * Each model pass is a real supervisor job named `<surveyId>-<pass>`, and the
 * supervisor caps a job id at 64 characters, so the headroom is reserved here
 * rather than discovered when the ninth batch is refused.
 */
const ID_PATTERN = /^[A-Za-z0-9._-]{8,48}$/;

/** One optional directory, then a plain name. Never a path the browser chose. */
const ARTIFACT_PATTERN = /^(?:[A-Za-z0-9_-]{1,32}\/)?[A-Za-z0-9._-]{1,64}$/;

export function isSurveyId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * Resolves a survey directory, and refuses anything that is not an id.
 *
 * Whitelist first, then the resolved path is checked against the root anyway.
 * The second check is not redundant: it is the one that still holds if the
 * pattern ever gains a case it did not anticipate.
 */
export function surveyDir(storageDir: string, id: unknown): string {
  if (!isSurveyId(id)) {
    throw new RelayError('invalid_request', `"${String(id)}" is not a survey id`);
  }

  const root = path.resolve(storageDir, SURVEYS_DIR);
  const resolved = path.resolve(root, id);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RelayError('invalid_request', `"${id}" resolves outside the surveys directory`);
  }

  return resolved;
}

export function surveyArtifactPath(storageDir: string, id: unknown, name: string): string {
  if (!ARTIFACT_PATTERN.test(name) || name.includes('..')) {
    throw new RelayError('invalid_request', `"${name}" is not an artefact name`);
  }
  return path.join(surveyDir(storageDir, id), ...name.split('/'));
}

export async function writeSurveyArtifact(
  storageDir: string,
  id: string,
  name: string,
  contents: string | Uint8Array,
): Promise<void> {
  const target = surveyArtifactPath(storageDir, id, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function readSurveyJson<T>(storageDir: string, id: string, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(surveyArtifactPath(storageDir, id, name), 'utf8')) as T;
  } catch {
    // A file that is there but unreadable is treated as absent: a half-written
    // record from an interrupted run should leave the survey reported as
    // failed, not crash the route trying to report it.
    return undefined;
  }
}

export function writeSurveyRecord(storageDir: string, record: SurveyRecord): Promise<void> {
  return writeSurveyArtifact(storageDir, record.surveyId, SURVEY_FILE, `${JSON.stringify(record, null, 2)}\n`);
}

export function readSurveyRecord(storageDir: string, id: string): Promise<SurveyRecord | undefined> {
  return readSurveyJson<SurveyRecord>(storageDir, id, SURVEY_FILE);
}

export function writeSurveyInventory(
  storageDir: string,
  id: string,
  inventory: SurveyInventory,
): Promise<void> {
  return writeSurveyArtifact(storageDir, id, INVENTORY_FILE, `${JSON.stringify(inventory, null, 2)}\n`);
}

export function readSurveyInventory(
  storageDir: string,
  id: string,
): Promise<SurveyInventory | undefined> {
  return readSurveyJson<SurveyInventory>(storageDir, id, INVENTORY_FILE);
}

/** The artefact name a node's render is filed under. Colons are not filenames. */
export function shotName(nodeId: string): string {
  return `${SHOTS_DIR}/${nodeId.replace(/[^A-Za-z0-9]+/g, '-')}.png`;
}

/** Every survey on disk, newest first. Directories with no record are skipped. */
export async function listSurveys(storageDir: string): Promise<SurveyRecord[]> {
  let entries;
  try {
    entries = await readdir(path.resolve(storageDir, SURVEYS_DIR), { withFileTypes: true });
  } catch {
    return []; // A root that does not exist yet is an empty root, not an error.
  }

  const records: SurveyRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSurveyId(entry.name)) continue;
    const record = await readSurveyRecord(storageDir, entry.name);
    if (record) records.push(record);
  }

  return records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** Removes a survey and everything it wrote. */
export async function deleteSurvey(storageDir: string, id: string): Promise<void> {
  await rm(surveyDir(storageDir, id), { recursive: true, force: true });
}
