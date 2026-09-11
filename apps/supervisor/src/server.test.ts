import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArmManager } from './arm-manager.js';
import { GpuSampler } from './gpu.js';
import { JobStore } from './jobs.js';
import { createControlServer } from './server.js';
import {
  EMPTY_PARAMS_SCHEMA,
  createHarness,
  makeConfig,
  makeTempRoot,
  residentManifest,
  writeArms,
  type Harness,
} from './test-utils.js';

const TOKEN = 'test-token-0123456789abcdef';

interface Fixture {
  baseUrl: string;
  harness: Harness;
  close: () => Promise<void>;
}

const open: Fixture[] = [];

async function startServer(): Promise<Fixture> {
  const root = await makeTempRoot();
  await writeArms(path.join(root, 'arms'), [
    { dirName: 'text-fake', manifest: residentManifest('text-fake'), paramsSchema: EMPTY_PARAMS_SCHEMA },
  ]);

  const config = makeConfig(root);
  const harness = createHarness();
  const manager = new ArmManager(config, {
    launch: harness.launch,
    terminateTree: harness.terminateTree,
    processExists: harness.processExists,
    fetch: harness.fetch,
    inspector: harness.inspector,
    healthIntervalMs: 5,
  });
  await manager.init();

  const server = createControlServer(config, { manager, jobs: new JobStore(), gpu: new GpuSampler() });
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const address = server.address() as AddressInfo;

  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    harness,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  open.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((fixture) => fixture.close()));
});

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('control server', () => {
  it('binds loopback only', async () => {
    const root = await makeTempRoot();
    await writeArms(path.join(root, 'arms'), []);
    const config = makeConfig(root);
    const manager = new ArmManager(config, { ...createHarness() });
    await manager.init();

    const server = createControlServer(config, { manager, jobs: new JobStore(), gpu: new GpuSampler() });
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
    const address = server.address() as AddressInfo;

    expect(address.address).toBe('127.0.0.1');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves health without a credential', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', ready: true });
  });

  it('rejects an unauthenticated inventory request', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/v1/arms`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects an unauthenticated start and launches nothing', async () => {
    const { baseUrl, harness } = await startServer();

    const response = await fetch(`${baseUrl}/v1/arms/text-fake/start`, { method: 'POST' });

    expect(response.status).toBe(401);
    expect(harness.specs).toHaveLength(0);
  });

  it('rejects a wrong credential', async () => {
    const { baseUrl, harness } = await startServer();

    const response = await fetch(`${baseUrl}/v1/arms/text-fake/start`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token-0123456789abc' },
    });

    expect(response.status).toBe(401);
    expect(harness.specs).toHaveLength(0);
  });

  it('refuses a caller-supplied command and launches nothing', async () => {
    const { baseUrl, harness } = await startServer();

    const response = await fetch(`${baseUrl}/v1/arms/text-fake/start`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'calc.exe', args: ['/c', 'whoami'], env: { PATH: '.' } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    expect(harness.specs).toHaveLength(0);
  });

  it('returns the inventory with parameter schemas', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/v1/arms`, { headers: auth });
    const body = (await response.json()) as { arms: { id: string; paramsSchema: unknown; state: string }[] };

    expect(response.status).toBe(200);
    expect(body.arms).toHaveLength(1);
    expect(body.arms[0]).toMatchObject({ id: 'text-fake', state: 'stopped' });
    expect(body.arms[0]?.paramsSchema).toEqual(EMPTY_PARAMS_SCHEMA);
  });

  it('never discloses an arm port or address to clients', async () => {
    const { baseUrl } = await startServer();

    const started = await fetch(`${baseUrl}/v1/arms/text-fake/start`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    });
    expect(started.status).toBe(200);

    const raw = await (await fetch(`${baseUrl}/v1/arms`, { headers: auth })).text();

    expect(JSON.parse(raw)).toMatchObject({ arms: [{ id: 'text-fake', state: 'running' }] });
    expect(raw).not.toMatch(/"port"/);
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('localhost');
  });

  it('reports an invalid manifest through the inventory instead of hiding it', async () => {
    const root = await makeTempRoot();
    await writeArms(path.join(root, 'arms'), [
      { dirName: 'broken', manifest: 'id: broken\nmodality: text\n', paramsSchema: EMPTY_PARAMS_SCHEMA },
    ]);
    const config = makeConfig(root);
    const manager = new ArmManager(config, { ...createHarness() });
    await manager.init();

    const server = createControlServer(config, { manager, jobs: new JobStore(), gpu: new GpuSampler() });
    await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
    const address = server.address() as AddressInfo;

    const body = (await (
      await fetch(`http://127.0.0.1:${address.port}/v1/arms`, { headers: auth })
    ).json()) as { arms: { id: string; state: string; detail: string | null }[] };

    expect(body.arms[0]?.state).toBe('invalid');
    expect(body.arms[0]?.detail).toBeTruthy();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('404s an unknown route', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/v1/nope`, { headers: auth });

    expect(response.status).toBe(404);
  });
});
