import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { launch } from './launcher.js';
import { processExists, terminateTree } from './process-tree.js';

const PARENT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'process.stdout.write(String(child.pid) + "\\n");',
  'setInterval(() => {}, 1000);',
].join('');

async function waitUntilGone(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(100);
  }
  return !processExists(pid);
}

describe('terminateTree', () => {
  it('kills the whole tree so no descendant survives', async () => {
    const parent = launch({
      command: process.execPath,
      args: ['-e', PARENT_SCRIPT],
      cwd: process.cwd(),
    });

    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child pid was never reported')), 10_000);
      parent.child.stdout.on('data', (chunk: string) => {
        const parsed = Number.parseInt(chunk.trim(), 10);
        if (Number.isInteger(parsed)) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });

    expect(processExists(parent.pid)).toBe(true);
    expect(processExists(childPid)).toBe(true);

    await terminateTree(parent.pid, 'force');

    await expect(waitUntilGone(parent.pid)).resolves.toBe(true);
    await expect(waitUntilGone(childPid)).resolves.toBe(true);
  }, 40_000);

  it('treats an already dead process as success', async () => {
    const short = launch({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
    await short.exited;

    await expect(terminateTree(short.pid, 'force')).resolves.toBeUndefined();
  }, 20_000);
});
