/**
 * Where an analysis lives on disk.
 *
 * ```
 * storage/analyses/<id>/
 *   analysis.json      state, arm, timings
 *   design.json        digest, tokens, id set, what was dropped
 *   design.png         the render, when one was taken
 *   ticket.json        normalised ticket with addressable passages
 *   passes/1-inventory.json … 4-model.json
 *   requirements.md    rendered from pass 3, not generated
 *   gaps.json
 *   _<block>.json      the proposed content model
 * ```
 *
 * The sources are written before the first pass rather than after the last.
 * The registry that tracks a running analysis is module state, and module state
 * dies with a Nuxt reload -- which in development is every edit -- so the
 * durable record has to exist before the long part starts. An analysis
 * interrupted at pass 3 still leaves its digest and its ticket readable, which
 * makes the rerun cheap.
 *
 * This is deliberately not the media library. That library's identity model is
 * "a file's path under storage is its id", its kinds are image and video, and
 * its listing, thumbnails and range requests all assume media. An analysis is a
 * directory of JSON, and it is simply not scanned: `listMedia` walks
 * `MEDIA_ROOTS`, which this root is not one of.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AnalysisRecord } from '#shared/analysis';

import { RelayError } from '../utils/supervisor';

/** The root under the managed storage directory. Not a media root. */
export const ANALYSES_DIR = 'analyses';

export const RECORD_FILE = 'analysis.json';
export const DESIGN_FILE = 'design.json';
export const TICKET_FILE = 'ticket.json';
export const GAPS_FILE = 'gaps.json';
export const REQUIREMENTS_FILE = 'requirements.md';

/**
 * An analysis id is a job id with room for a suffix.
 *
 * Each pass is a real supervisor job named `<analysisId>-p<n>`, and the
 * supervisor caps a job id at 64 characters, so the headroom for that suffix
 * has to be reserved here rather than discovered when pass 4 is refused.
 */
const ID_PATTERN = /^[A-Za-z0-9._-]{8,56}$/;

/** Artefact names are a whitelist: one optional directory, then a plain name. */
const ARTIFACT_PATTERN = /^(?:[A-Za-z0-9_-]{1,32}\/)?[A-Za-z0-9._-]{1,64}$/;

export function isAnalysisId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * Resolves an analysis directory, and refuses anything that is not an id.
 *
 * Whitelist first, then the resolved path is checked against the root anyway.
 * The second check is not redundant: it is the one that still holds if the
 * pattern ever gains a case it did not anticipate.
 */
export function analysisDir(storageDir: string, id: unknown): string {
  if (!isAnalysisId(id)) {
    throw new RelayError('invalid_request', `"${String(id)}" is not an analysis id`);
  }

  const root = path.resolve(storageDir, ANALYSES_DIR);
  const resolved = path.resolve(root, id);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RelayError('invalid_request', `"${id}" resolves outside the analyses directory`);
  }

  return resolved;
}

export function artifactPath(storageDir: string, id: unknown, name: string): string {
  if (!ARTIFACT_PATTERN.test(name) || name.includes('..')) {
    throw new RelayError('invalid_request', `"${name}" is not an artefact name`);
  }
  return path.join(analysisDir(storageDir, id), ...name.split('/'));
}

/** Writes one artefact, creating the analysis directory if it is the first. */
export async function writeArtifact(
  storageDir: string,
  id: string,
  name: string,
  contents: string | Uint8Array,
): Promise<void> {
  const target = artifactPath(storageDir, id, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/** Reads one artefact, or undefined when it was never written. */
export async function readArtifact(
  storageDir: string,
  id: string,
  name: string,
): Promise<string | undefined> {
  try {
    return await readFile(artifactPath(storageDir, id, name), 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeJson(
  storageDir: string,
  id: string,
  name: string,
  value: unknown,
): Promise<void> {
  await writeArtifact(storageDir, id, name, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Reads a JSON artefact.
 *
 * A file that is there but unreadable is treated as absent: a half-written
 * record from an interrupted run should leave the analysis reported as failed,
 * not crash the route that is trying to report it.
 */
export async function readJson<T>(storageDir: string, id: string, name: string): Promise<T | undefined> {
  const raw = await readArtifact(storageDir, id, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeRecord(storageDir: string, record: AnalysisRecord): Promise<void> {
  return writeJson(storageDir, record.analysisId, RECORD_FILE, record);
}

export function readRecord(storageDir: string, id: string): Promise<AnalysisRecord | undefined> {
  return readJson<AnalysisRecord>(storageDir, id, RECORD_FILE);
}

/** Every analysis on disk, newest first. Directories with no record are skipped. */
export async function listAnalyses(storageDir: string): Promise<AnalysisRecord[]> {
  let entries;
  try {
    entries = await readdir(path.resolve(storageDir, ANALYSES_DIR), { withFileTypes: true });
  } catch {
    return []; // A root that does not exist yet is an empty root, not an error.
  }

  const records: AnalysisRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isAnalysisId(entry.name)) continue;
    const record = await readRecord(storageDir, entry.name);
    if (record) records.push(record);
  }

  return records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
