import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectPathKeys, validateParams } from './params.js';
import { LaunchResolutionError, resolveArgs } from './substitute.js';

const STORAGE = path.resolve('C:/git/ai-studio/storage');

const SCHEMA = {
  type: 'object',
  required: ['prompt', 'model'],
  properties: {
    prompt: { type: 'string' },
    model: { type: 'string', format: 'aistudio-path' },
    outPath: { type: 'string', format: 'aistudio-path' },
    steps: { type: 'integer', minimum: 1, maximum: 150, default: 20 },
  },
} as const;

describe('parameter validation', () => {
  it('identifies path-typed parameters from the schema', () => {
    expect(collectPathKeys({ ...SCHEMA })).toEqual(new Set(['model', 'outPath']));
  });

  it('applies schema defaults', () => {
    const result = validateParams({ ...SCHEMA }, { prompt: 'a cat', model: 'models/sd15.safetensors' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values['steps']).toBe(20);
  });

  it('rejects a value that violates the schema', () => {
    const result = validateParams({ ...SCHEMA }, { prompt: 'a cat', model: 'models/x', steps: 9001 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain('steps');
  });

  it('rejects parameters the schema does not declare', () => {
    const result = validateParams({ ...SCHEMA }, { prompt: 'a cat', model: 'models/x', command: 'calc.exe' });

    expect(result.ok).toBe(false);
  });
});

describe('launch argument resolution', () => {
  const pathKeys = new Set(['model', 'outPath']);

  it('substitutes values into individual arguments', () => {
    const args = resolveArgs({
      args: ['-m', '{{model}}', '-p', '{{prompt}}', '--port', '{{port}}'],
      values: { model: 'models/sd15.safetensors', prompt: 'a cat', port: 41234 },
      storageDir: STORAGE,
      pathKeys,
    });

    expect(args).toEqual([
      '-m',
      path.join(STORAGE, 'models', 'sd15.safetensors'),
      '-p',
      'a cat',
      '--port',
      '41234',
    ]);
  });

  it('keeps shell metacharacters inside a single literal argument', () => {
    const hostile = 'a cat" & del /q C:\\Windows\\* & echo $(whoami) `id` | more';
    const args = resolveArgs({
      args: ['-p', '{{prompt}}'],
      values: { prompt: hostile },
      storageDir: STORAGE,
    });

    expect(args).toHaveLength(2);
    expect(args[1]).toBe(hostile);
  });

  it('does not split an argument that mixes literal text and a placeholder', () => {
    const args = resolveArgs({
      args: ['--prompt={{prompt}}'],
      values: { prompt: 'two words' },
      storageDir: STORAGE,
    });

    expect(args).toEqual(['--prompt=two words']);
  });

  it.each([
    ['relative traversal', '../../Windows/System32/calc.exe'],
    ['nested traversal', 'models/../../secrets.txt'],
    ['absolute path outside storage', 'C:/Windows/System32/calc.exe'],
    ['storage root itself', '.'],
  ])('rejects a path parameter using %s', (_label, value) => {
    expect(() =>
      resolveArgs({
        args: ['-m', '{{model}}'],
        values: { model: value },
        storageDir: STORAGE,
        pathKeys,
      }),
    ).toThrow(LaunchResolutionError);
  });

  it('accepts a path parameter that stays inside storage', () => {
    const args = resolveArgs({
      args: ['-o', '{{outPath}}'],
      values: { outPath: 'outputs/2026/run-1.png' },
      storageDir: STORAGE,
      pathKeys,
    });

    expect(args[1]).toBe(path.join(STORAGE, 'outputs', '2026', 'run-1.png'));
  });

  it('refuses a placeholder with no supplied value', () => {
    expect(() =>
      resolveArgs({ args: ['-m', '{{model}}'], values: {}, storageDir: STORAGE, pathKeys }),
    ).toThrow(/no value supplied/i);
  });

  it('refuses a value containing a null byte', () => {
    expect(() =>
      resolveArgs({ args: ['-p', '{{prompt}}'], values: { prompt: 'a\0b' }, storageDir: STORAGE }),
    ).toThrow(/null byte/i);
  });
});
