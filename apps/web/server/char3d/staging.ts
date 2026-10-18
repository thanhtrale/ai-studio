/**
 * Moving a run's files between the character store and the two roots arms may touch.
 *
 * Arms read only under `inputs/` and write only under `outputs/` -- that
 * confinement is theirs, and this feature does not get an exception. So a
 * run's inputs are hard-linked into `inputs/.char3d/<character>/...` (same
 * volume, no copy; a copy only where a link cannot be made), and an arm writes
 * into `outputs/.char3d/<character>/<run>/...`, from where everything is moved
 * into the run's own directory once the job is back. Both trees are dot
 * folders, which the library does not list.
 */

import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { charDir, runDir } from './store';

const STAGE = '.char3d';

/** Where an arm writes for this run, relative to `outputs/`. */
export const outRel = (character: string, run: string, ...parts: string[]): string =>
  [STAGE, character, run, ...parts].join('/');

const stagingOut = (storageDir: string, character: string, run: string): string =>
  path.resolve(storageDir, 'outputs', STAGE, character, run);

/**
 * A store file made readable to arms. Returns its path relative to `inputs/`.
 *
 * The staged copy mirrors the file's place in the character directory, so two
 * runs' `mesh.glb` never collide. A stale link from an earlier attempt is
 * replaced: the store is the truth.
 */
export async function stageIn(storageDir: string, character: string, absolute: string): Promise<string> {
  const base = charDir(storageDir, character);
  const rel = path.relative(base, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${absolute} is not a file of ${character}`);
  const target = path.resolve(storageDir, 'inputs', STAGE, character, rel);
  await mkdir(path.dirname(target), { recursive: true });
  if (existsSync(target)) await unlink(target);
  try {
    await link(absolute, target);
  } catch {
    await copyFile(absolute, target);
  }
  return [STAGE, character, ...rel.split(path.sep)].join('/');
}

async function moveTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await moveTree(source, target);
    } else {
      if (existsSync(target)) await rm(target, { force: true });
      try {
        await rename(source, target);
      } catch {
        await copyFile(source, target);
        await unlink(source);
      }
    }
  }
}

/**
 * Everything the arms wrote for this run, moved into the run's directory.
 *
 * Returns a function that turns a path an arm reported -- absolute, under the
 * staging tree -- into where the file now is. A path from anywhere else is
 * refused, because the run record must never point outside the store.
 */
export async function collectOut(
  storageDir: string,
  character: string,
  run: string,
): Promise<(reported: string) => string> {
  const from = stagingOut(storageDir, character, run);
  const to = runDir(storageDir, character, run);
  try {
    if ((await stat(from)).isDirectory()) await moveTree(from, to);
    await rm(from, { recursive: true, force: true });
  } catch {
    // Nothing was written: the mapping below still refuses foreign paths.
  }
  const prefix = from.toLowerCase() + path.sep;
  return (reported: string): string => {
    const resolved = path.resolve(reported);
    if (!resolved.toLowerCase().startsWith(prefix)) {
      // Already moved, or written straight into the store by a later step.
      if (resolved.toLowerCase().startsWith(to.toLowerCase() + path.sep)) return resolved;
      throw new Error(`an arm reported ${reported}, which is not this run's output`);
    }
    return path.join(to, resolved.slice(prefix.length));
  };
}
