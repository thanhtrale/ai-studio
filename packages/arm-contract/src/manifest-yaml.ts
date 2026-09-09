import { parse as parseYaml } from 'yaml';

import { parseArmManifest, type ManifestParseResult } from './manifest.js';

export function parseArmManifestYaml(source: string): ManifestParseResult {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `invalid YAML: ${(error as Error).message}` }],
    };
  }

  return parseArmManifest(document);
}
