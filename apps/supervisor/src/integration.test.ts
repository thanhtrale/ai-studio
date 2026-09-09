import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { ArmManager } from './arm-manager.js';
import { processExists } from './process-tree.js';
import { EMPTY_PARAMS_SCHEMA, makeConfig, makeTempRoot, writeArms } from './test-utils.js';

/**
 * A real arm: it binds the port it was given, answers the health check, and
 * spawns a child so process-tree termination has something to prove.
 */
const ARM_SERVER = [
  'import http from "node:http";',
  'import { spawn } from "node:child_process";',
  'import { writeFileSync } from "node:fs";',
  'const port = Number(process.argv[2]);',
  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'writeFileSync(process.argv[3], String(child.pid));',
  'http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");',
].join('\n');

function manifestFor(id: string, dir: string): string {
  return [
    `id: ${id}`,
    'modality: text',
    'protocol: native',
    'lifecycle: resident',
    'resources:',
    '  gpu: exclusive',
    '  vramEstimateMb: 100',
    'launch:',
    `  command: ${JSON.stringify(process.execPath)}`,
    `  args: ["server.mjs", "{{port}}", ${JSON.stringify(path.join(dir, 'child.pid'))}]`,
    'health:',
    '  type: http',
    '  path: /',
    '  timeoutMs: 20000',
    'params: ./params.schema.json',
    '',
  ].join('\n');
}

const managers: ArmManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
});

async function childPidOf(dir: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return Number.parseInt(await readFile(path.join(dir, 'child.pid'), 'utf8'), 10);
    } catch {
      await delay(100);
    }
  }
  throw new Error(`arm in ${dir} never reported a child pid`);
}

async function buildManager(): Promise<{
  manager: ArmManager;
  dirs: { alpha: string; beta: string };
  root: string;
}> {
  const root = await makeTempRoot();
  const armsDir = path.join(root, 'arms');
  const dirs = { alpha: path.join(armsDir, 'alpha'), beta: path.join(armsDir, 'beta') };

  await writeArms(armsDir, [
    { dirName: 'alpha', manifest: manifestFor('alpha', dirs.alpha), paramsSchema: EMPTY_PARAMS_SCHEMA },
    { dirName: 'beta', manifest: manifestFor('beta', dirs.beta), paramsSchema: EMPTY_PARAMS_SCHEMA },
  ]);
  await writeFile(path.join(dirs.alpha, 'server.mjs'), ARM_SERVER, 'utf8');
  await writeFile(path.join(dirs.beta, 'server.mjs'), ARM_SERVER, 'utf8');

  const manager = new ArmManager(makeConfig(root, { stopGraceMs: 5000 }));
  await manager.init();
  managers.push(manager);
  return { manager, dirs, root };
}

describe('supervisor integration', () => {
  it('starts a real arm, evicts it for another, and leaves no descendant behind', async () => {
    const { manager, dirs } = await buildManager();

    const started = await manager.start('alpha');
    expect(started.arm.state).toBe('running');

    const alphaChild = await childPidOf(dirs.alpha);
    expect(processExists(alphaChild)).toBe(true);

    const switched = await manager.start('beta');

    expect(switched.evicted).toEqual(['alpha']);
    expect(switched.arm.state).toBe('running');
    expect(manager.summary('alpha').state).toBe('stopped');

    // The evicted arm's child must be gone, or its GPU memory would never return.
    for (let attempt = 0; attempt < 50 && processExists(alphaChild); attempt += 1) {
      await delay(100);
    }
    expect(processExists(alphaChild)).toBe(false);

    const betaChild = await childPidOf(dirs.beta);
    await manager.stop('beta');

    for (let attempt = 0; attempt < 50 && processExists(betaChild); attempt += 1) {
      await delay(100);
    }
    expect(processExists(betaChild)).toBe(false);
    expect(manager.summary('beta').state).toBe('stopped');
  }, 120_000);

  it('keeps a running arm alive across a supervisor restart and adopts it', async () => {
    const { manager, root } = await buildManager();
    await manager.start('alpha');

    // A second manager over the same state directory is what a restart looks like.
    const restarted = new ArmManager(makeConfig(root, { stopGraceMs: 5000 }));
    await restarted.init();
    managers.push(restarted);

    expect(restarted.summary('alpha').state).toBe('running');

    await restarted.stop('alpha');
    expect(restarted.summary('alpha').state).toBe('stopped');
  }, 120_000);
});
