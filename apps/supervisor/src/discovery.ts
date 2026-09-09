import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  collectPathKeys,
  formatManifestIssues,
  parseArmManifestYaml,
  type ArmManifest,
  type ParamsSchema,
} from '@ai-studio/arm-contract';

export const MANIFEST_FILENAME = 'arm.yaml';

export interface DiscoveredArm {
  id: string;
  dir: string;
  manifest: ArmManifest;
  paramsSchema: ParamsSchema;
  pathKeys: Set<string>;
}

export interface InvalidArm {
  /** Manifest id when it could be read, otherwise the directory name. */
  id: string;
  dir: string;
  error: string;
}

export interface DiscoveryResult {
  arms: DiscoveredArm[];
  invalid: InvalidArm[];
}

interface Candidate {
  dir: string;
  dirName: string;
  arm?: DiscoveredArm;
  invalid?: InvalidArm;
}

async function inspect(armsDir: string, dirName: string): Promise<Candidate | null> {
  const dir = path.join(armsDir, dirName);
  const manifestPath = path.join(dir, MANIFEST_FILENAME);

  let source: string;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch {
    // A directory without a manifest is not an arm at all.
    return null;
  }

  const parsed = parseArmManifestYaml(source);
  if (!parsed.ok) {
    return { dir, dirName, invalid: { id: dirName, dir, error: formatManifestIssues(parsed.issues) } };
  }

  const manifest = parsed.manifest;
  const schemaPath = path.resolve(dir, manifest.params);

  let paramsSchema: ParamsSchema;
  try {
    paramsSchema = JSON.parse(await readFile(schemaPath, 'utf8')) as ParamsSchema;
  } catch (error) {
    return {
      dir,
      dirName,
      invalid: {
        id: manifest.id,
        dir,
        error: `params: cannot read parameter schema "${manifest.params}" (${(error as Error).message})`,
      },
    };
  }

  return {
    dir,
    dirName,
    arm: { id: manifest.id, dir, manifest, paramsSchema, pathKeys: collectPathKeys(paramsSchema) },
  };
}

export async function discoverArms(armsDir: string): Promise<DiscoveryResult> {
  let entries;
  try {
    entries = await readdir(armsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read arms directory "${armsDir}": ${(error as Error).message}`, {
      cause: error,
    });
  }

  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => inspect(armsDir, entry.name)),
    )
  ).filter((candidate): candidate is Candidate => candidate !== null);

  const byId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidate.arm) continue;
    const bucket = byId.get(candidate.arm.id);
    if (bucket) bucket.push(candidate);
    else byId.set(candidate.arm.id, [candidate]);
  }

  const arms: DiscoveredArm[] = [];
  const invalid: InvalidArm[] = [];

  for (const candidate of candidates) {
    if (candidate.invalid) {
      invalid.push(candidate.invalid);
      continue;
    }
    if (!candidate.arm) continue;

    const conflicting = byId.get(candidate.arm.id) ?? [];
    if (conflicting.length > 1) {
      const directories = conflicting.map((entry) => entry.dirName).sort().join(', ');
      invalid.push({
        id: candidate.arm.id,
        dir: candidate.dir,
        error: `id: duplicate arm id "${candidate.arm.id}" declared by ${directories}`,
      });
      continue;
    }

    arms.push(candidate.arm);
  }

  arms.sort((a, b) => a.id.localeCompare(b.id));
  invalid.sort((a, b) => a.id.localeCompare(b.id));

  return { arms, invalid };
}
