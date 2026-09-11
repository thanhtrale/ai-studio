import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  collectPathKeys,
  formatManifestIssues,
  parseArmManifestYaml,
  validateParams,
  type ParamsSchema,
} from '@ai-studio/arm-contract';
import { describe, expect, it } from 'vitest';

const ARMS_DIR = path.resolve(import.meta.dirname, '..', 'arms');

const armDirectories = readdirSync(ARMS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('scaffolded arm packages', () => {
  it('discovers every scaffolded arm', () => {
    expect(armDirectories).toEqual(
      expect.arrayContaining([
        'text-llamacpp-cu124',
        'image-qwen-edit-sdcpp',
        'video-ltx25-diffusers',
      ]),
    );
  });

  it.each(armDirectories)('%s has a manifest that passes contract validation', (name) => {
    const manifestPath = path.join(ARMS_DIR, name, 'arm.yaml');
    expect(existsSync(manifestPath)).toBe(true);

    const result = parseArmManifestYaml(readFileSync(manifestPath, 'utf8'));
    if (!result.ok) {
      throw new Error(`${name}: ${formatManifestIssues(result.issues)}`);
    }

    expect(result.manifest.id).toBe(name);
  });

  it.each(armDirectories)('%s references a usable parameter schema', (name) => {
    const armDir = path.join(ARMS_DIR, name);
    const result = parseArmManifestYaml(readFileSync(path.join(armDir, 'arm.yaml'), 'utf8'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const schemaPath = path.resolve(armDir, result.manifest.params);
    expect(existsSync(schemaPath)).toBe(true);

    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as ParamsSchema;
    // An empty parameter object is expected to fail validation, but compiling
    // the schema itself must not error.
    const validation = validateParams(schema, {});
    if (!validation.ok) {
      expect(validation.issues.map((issue) => issue.message).join('; ')).not.toMatch(
        /invalid parameter schema/i,
      );
    }

    // Every placeholder used in the launch arguments must be satisfiable.
    const declared = new Set(Object.keys((schema['properties'] as object | undefined) ?? {}));
    declared.add('port');
    for (const arg of result.manifest.launch.args) {
      for (const match of arg.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
        expect(declared).toContain(match[1]);
      }
    }

    // Anything that ends up as a filesystem path must be declared as one.
    const pathKeys = collectPathKeys(schema);
    for (const key of ['model', 'outPath']) {
      if (declared.has(key)) expect(pathKeys).toContain(key);
    }
  });

  // A console offers the arms that declare its job contract. Which arms those
  // are is a fact about this repository, so it is pinned here. The text arm
  // declares nothing because nothing has been built to drive it.
  it.each([
    ['image-qwen-edit-sdcpp', ['image.generate']],
    ['video-ltx25-diffusers', ['video.generate']],
    ['text-llamacpp-cu124', []],
  ])('%s declares the job contracts it can actually serve', (name, expected) => {
    const result = parseArmManifestYaml(readFileSync(path.join(ARMS_DIR, name, 'arm.yaml'), 'utf8'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.capabilities).toEqual(expected);
  });

  it('assigns a unique id to every arm', () => {
    const ids = armDirectories.map((name) => {
      const result = parseArmManifestYaml(readFileSync(path.join(ARMS_DIR, name, 'arm.yaml'), 'utf8'));
      return result.ok ? result.manifest.id : name;
    });

    expect(new Set(ids).size).toBe(ids.length);
  });
});
