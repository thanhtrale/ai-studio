import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LaunchRegistry, buildCommandLine, type LaunchRecord } from './registry.js';
import { makeTempRoot } from './test-utils.js';

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    armId: 'text-fake',
    pid: 4242,
    startedAtMs: 1_700_000_000_000,
    processStartedAtMs: 1_700_000_000_000,
    commandLine: 'fake-arm --port 5000',
    port: 5000,
    ...overrides,
  };
}

async function newRegistry(): Promise<LaunchRegistry> {
  const root = await makeTempRoot();
  return new LaunchRegistry(path.join(root, 'state'));
}

describe('LaunchRegistry', () => {
  it('writes a record to disk on launch', async () => {
    const registry = await newRegistry();

    await registry.add(record());

    const written = JSON.parse(await readFile(registry.file, 'utf8')) as LaunchRecord[];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ armId: 'text-fake', pid: 4242, port: 5000 });
  });

  it('keeps one record per arm', async () => {
    const registry = await newRegistry();

    await registry.add(record({ pid: 1 }));
    await registry.add(record({ pid: 2 }));

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.pid).toBe(2);
  });

  it('clears the record on a clean exit', async () => {
    const registry = await newRegistry();
    await registry.add(record());

    await registry.remove('text-fake');

    expect(registry.list()).toEqual([]);
    expect(JSON.parse(await readFile(registry.file, 'utf8'))).toEqual([]);
  });

  it('survives a restart by reloading what was written', async () => {
    const registry = await newRegistry();
    await registry.add(record());

    const reopened = new LaunchRegistry(path.dirname(registry.file));

    await expect(reopened.load()).resolves.toMatchObject([{ armId: 'text-fake', pid: 4242 }]);
  });

  it('treats a missing or corrupt file as no records', async () => {
    const registry = await newRegistry();

    await expect(registry.load()).resolves.toEqual([]);
  });

  it('records the command so the process can be recognised later', () => {
    expect(buildCommandLine('fake-arm', ['--port', '5000'])).toBe('fake-arm --port 5000');
  });
});
