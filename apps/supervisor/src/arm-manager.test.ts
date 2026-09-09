import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArmManager, ArmControlError } from './arm-manager.js';
import type { ProcessInspector } from './process-inspector.js';
import {
  EMPTY_PARAMS_SCHEMA,
  PROMPT_PARAMS_SCHEMA,
  createHarness,
  makeConfig,
  makeTempRoot,
  oneshotManifest,
  residentManifest,
  writeArms,
  type ArmFixture,
  type Harness,
} from './test-utils.js';
import type { SupervisorConfig } from './config.js';

interface Setup {
  manager: ArmManager;
  harness: Harness;
  config: SupervisorConfig;
}

async function setup(fixtures: readonly ArmFixture[]): Promise<Setup> {
  const root = await makeTempRoot();
  await writeArms(path.join(root, 'arms'), fixtures);

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

  return { manager, harness, config };
}

const residentFixture = (id: string, timeoutMs?: number): ArmFixture => ({
  dirName: id,
  manifest: residentManifest(id, timeoutMs === undefined ? {} : { timeoutMs }),
  paramsSchema: EMPTY_PARAMS_SCHEMA,
});

function stateOf(manager: ArmManager, id: string): string {
  return manager.summary(id).state;
}

describe('ArmManager start', () => {
  it('reaches running once the health check succeeds', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake')]);

    const result = await manager.start('text-fake');

    expect(result.arm.state).toBe('running');
    expect(result.evicted).toEqual([]);
    expect(harness.specs).toHaveLength(1);
  });

  it('launches with an argv array and the allocated port injected', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake')]);

    await manager.start('text-fake');

    const spec = harness.specs[0];
    expect(spec?.command).toBe('fake-arm');
    expect(Array.isArray(spec?.args)).toBe(true);
    expect(spec?.args[0]).toBe('--port');
    expect(Number.parseInt(spec?.args[1] ?? '', 10)).toBeGreaterThan(0);
  });

  it('records the launch so a later supervisor run can recognise it', async () => {
    const { manager, config } = await setup([residentFixture('text-fake')]);

    await manager.start('text-fake');

    await expect(access(path.join(config.stateDir, 'launches.json'))).resolves.toBeUndefined();
  });

  it('fails with a health timeout and force-kills the process', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake', 60)]);
    harness.healthy = false;

    await expect(manager.start('text-fake')).rejects.toMatchObject({ code: 'health_timeout' });

    expect(stateOf(manager, 'text-fake')).toBe('failed');
    expect(harness.terminations).toContainEqual({ pid: harness.last().pid, mode: 'force' });
  });

  it('fails when the process exits during startup and keeps the exit code', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake', 2000)]);
    harness.healthy = false;

    const pending = manager.start('text-fake');
    (await harness.waitForProcess()).exit(9);

    await expect(pending).rejects.toThrow(/exited during startup with code 9/);
    expect(stateOf(manager, 'text-fake')).toBe('failed');
  });

  it('is a no-op when the arm is already running', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake')]);

    await manager.start('text-fake');
    const second = await manager.start('text-fake');

    expect(second.arm.state).toBe('running');
    expect(harness.specs).toHaveLength(1);
  });

  it('refuses to keep a one-shot arm alive', async () => {
    const { manager } = await setup([
      { dirName: 'img', manifest: oneshotManifest('img'), paramsSchema: PROMPT_PARAMS_SCHEMA },
    ]);

    await expect(manager.start('img')).rejects.toBeInstanceOf(ArmControlError);
  });

  it('rejects an unknown arm', async () => {
    const { manager } = await setup([residentFixture('text-fake')]);

    await expect(manager.start('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a parameter value that fails the arm schema', async () => {
    const { manager, harness } = await setup([
      {
        dirName: 'img',
        manifest: residentManifest('img').replace(
          '  args: ["--port", "{{port}}"]',
          '  args: ["--port", "{{port}}", "--prompt", "{{prompt}}"]',
        ),
        paramsSchema: PROMPT_PARAMS_SCHEMA,
      },
    ]);

    await expect(manager.start('img', { prompt: 42 })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(harness.specs).toHaveLength(0);
  });
});

describe('ArmManager stop', () => {
  it('stops gracefully when the arm exits within the grace period', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake')]);
    await manager.start('text-fake');

    const summary = await manager.stop('text-fake');

    expect(summary.state).toBe('stopped');
    expect(harness.terminations.map((entry) => entry.mode)).toEqual(['graceful']);
  });

  it('escalates to a forced kill when the arm ignores the graceful signal', async () => {
    const { manager, harness } = await setup([residentFixture('text-fake')]);
    await manager.start('text-fake');
    harness.gracefulWorks = false;

    const summary = await manager.stop('text-fake');

    expect(summary.state).toBe('stopped');
    expect(harness.terminations.map((entry) => entry.mode)).toEqual(['graceful', 'force']);
  });

  it('does not leak the allocated port across repeated start and stop cycles', async () => {
    const { manager } = await setup([residentFixture('text-fake')]);

    await manager.start('text-fake');
    await manager.stop('text-fake');
    await manager.start('text-fake');
    await manager.stop('text-fake');

    expect(stateOf(manager, 'text-fake')).toBe('stopped');
  });
});

describe('ArmManager GPU arbitration', () => {
  it('evicts the incumbent before launching the requested arm', async () => {
    const { manager, harness } = await setup([residentFixture('arm-a'), residentFixture('arm-b')]);
    await manager.start('arm-a');
    const incumbentPid = harness.last().pid;

    const result = await manager.start('arm-b');

    expect(result.evicted).toEqual(['arm-a']);
    expect(stateOf(manager, 'arm-a')).toBe('stopped');
    expect(stateOf(manager, 'arm-b')).toBe('running');

    // The incumbent was terminated before the second launch was issued.
    const killIndex = harness.terminations.findIndex((entry) => entry.pid === incumbentPid);
    expect(killIndex).toBe(0);
    expect(harness.specs).toHaveLength(2);
  });

  it('aborts the start and names the incumbent when eviction fails', async () => {
    const { manager, harness } = await setup([residentFixture('arm-a'), residentFixture('arm-b')]);
    await manager.start('arm-a');
    harness.gracefulWorks = false;
    harness.forceWorks = false;

    const error = await manager.start('arm-b').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'eviction_failed' });
    expect((error as Error).message).toContain('arm-a');
    expect(harness.specs).toHaveLength(1);
    expect(stateOf(manager, 'arm-b')).toBe('stopped');
  });

  it('keeps a surviving incumbent in the slot so it is not silently freed', async () => {
    const { manager, harness } = await setup([residentFixture('arm-a'), residentFixture('arm-b')]);
    await manager.start('arm-a');
    harness.gracefulWorks = false;
    harness.forceWorks = false;

    await manager.start('arm-b').catch(() => undefined);

    // The process is still alive, so the arm must not look stopped.
    expect(stateOf(manager, 'arm-a')).toBe('running');
    await expect(manager.start('arm-b')).rejects.toMatchObject({ code: 'eviction_failed' });
  });
});

describe('ArmManager reconciliation', () => {
  async function seedRegistry(
    fixtures: readonly ArmFixture[],
    entry: Record<string, unknown>,
    inspector: ProcessInspector,
  ): Promise<{ manager: ArmManager; config: SupervisorConfig }> {
    const root = await makeTempRoot();
    await writeArms(path.join(root, 'arms'), fixtures);

    const config = makeConfig(root);
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(path.join(config.stateDir, 'launches.json'), JSON.stringify([entry]), 'utf8');

    const harness = createHarness();
    const manager = new ArmManager(config, {
      launch: harness.launch,
      terminateTree: harness.terminateTree,
      processExists: harness.processExists,
      fetch: harness.fetch,
      inspector,
      healthIntervalMs: 5,
    });
    await manager.init();
    return { manager, config };
  }

  const seededRecord = {
    armId: 'text-fake',
    pid: 8888,
    startedAtMs: 1_700_000_000_000,
    processStartedAtMs: 1_700_000_000_000,
    commandLine: 'fake-arm --port 5000',
    port: 5000,
  };

  it('adopts a still-running arm after a supervisor restart', async () => {
    const { manager } = await seedRegistry([residentFixture('text-fake')], seededRecord, {
      async inspect() {
        return { pid: 8888, commandLine: 'fake-arm --port 5000', startedAtMs: 1_700_000_000_000 };
      },
    });

    expect(stateOf(manager, 'text-fake')).toBe('running');
  });

  it('discards a stale record without resurrecting the arm', async () => {
    const { manager, config } = await seedRegistry([residentFixture('text-fake')], seededRecord, {
      async inspect() {
        return null;
      },
    });

    expect(stateOf(manager, 'text-fake')).toBe('stopped');
    const written = await readFile(path.join(config.stateDir, 'launches.json'), 'utf8');
    expect(JSON.parse(written)).toEqual([]);
  });

  it('leaves a recycled pid alone rather than adopting or killing it', async () => {
    const { manager } = await seedRegistry([residentFixture('text-fake')], seededRecord, {
      async inspect() {
        return { pid: 8888, commandLine: 'notepad.exe', startedAtMs: 1_800_000_000_000 };
      },
    });

    expect(stateOf(manager, 'text-fake')).toBe('stopped');
  });

  it('refuses control requests until reconciliation has finished', async () => {
    const root = await makeTempRoot();
    await writeArms(path.join(root, 'arms'), [residentFixture('text-fake')]);
    const manager = new ArmManager(makeConfig(root), { ...createHarness() });

    expect(manager.ready).toBe(false);
    await expect(manager.start('text-fake')).rejects.toMatchObject({ code: 'reconciling' });
  });
});

describe('ArmManager one-shot execution', () => {
  it('runs to completion and surfaces the exit code and output', async () => {
    const { manager, harness } = await setup([
      { dirName: 'img', manifest: oneshotManifest('img'), paramsSchema: PROMPT_PARAMS_SCHEMA },
    ]);

    const pending = manager.runOnce('img', { prompt: 'a cat' });
    queueMicrotask(() => {
      const created = harness.last();
      created.output = 'saved 1 image';
      created.exit(0);
    });

    await expect(pending).resolves.toEqual({ exitCode: 0, output: 'saved 1 image' });
    expect(harness.last().alive).toBe(false);
    expect(harness.specs[0]?.args).toEqual(['--prompt', 'a cat']);
  });

  it('refuses to run a resident arm as one-shot', async () => {
    const { manager } = await setup([residentFixture('text-fake')]);

    await expect(manager.runOnce('text-fake')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
