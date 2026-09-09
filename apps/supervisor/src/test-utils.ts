import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SupervisorConfig } from './config.js';
import type { ExitInfo, LaunchSpec, LaunchedProcess } from './launcher.js';
import type { ProcessIdentity, ProcessInspector } from './process-inspector.js';
import type { TerminationMode } from './process-tree.js';

export async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'aistudio-test-'));
}

export interface ArmFixture {
  dirName: string;
  /** Raw arm.yaml contents. Omit to create a directory with no manifest. */
  manifest?: string;
  /** Written to params.schema.json. Omit to skip the file entirely. */
  paramsSchema?: unknown;
}

export const EMPTY_PARAMS_SCHEMA = { type: 'object', properties: {} } as const;

export async function writeArms(armsDir: string, fixtures: readonly ArmFixture[]): Promise<void> {
  await mkdir(armsDir, { recursive: true });

  for (const fixture of fixtures) {
    const dir = path.join(armsDir, fixture.dirName);
    await mkdir(dir, { recursive: true });

    if (fixture.manifest !== undefined) {
      await writeFile(path.join(dir, 'arm.yaml'), fixture.manifest, 'utf8');
    }
    if (fixture.paramsSchema !== undefined) {
      await writeFile(
        path.join(dir, 'params.schema.json'),
        JSON.stringify(fixture.paramsSchema, null, 2),
        'utf8',
      );
    }
  }
}

export function residentManifest(id: string, extra: { timeoutMs?: number } = {}): string {
  return [
    `id: ${id}`,
    'modality: text',
    'protocol: openai',
    'lifecycle: resident',
    'resources:',
    '  gpu: exclusive',
    '  vramEstimateMb: 1000',
    'launch:',
    '  command: fake-arm',
    '  args: ["--port", "{{port}}"]',
    'health:',
    '  type: http',
    '  path: /health',
    `  timeoutMs: ${extra.timeoutMs ?? 500}`,
    'params: ./params.schema.json',
    '',
  ].join('\n');
}

export function oneshotManifest(id: string): string {
  return [
    `id: ${id}`,
    'modality: image',
    'protocol: cli',
    'lifecycle: oneshot',
    'resources:',
    '  gpu: exclusive',
    'launch:',
    '  command: fake-cli',
    '  args: ["--prompt", "{{prompt}}"]',
    'params: ./params.schema.json',
    '',
  ].join('\n');
}

export const PROMPT_PARAMS_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
} as const;

export function makeConfig(root: string, overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    token: 'test-token-0123456789abcdef',
    armsDir: path.join(root, 'arms'),
    storageDir: path.join(root, 'storage'),
    stateDir: path.join(root, 'storage', 'cache', 'supervisor'),
    stopGraceMs: 200,
    ...overrides,
  };
}

class FakeProcess {
  readonly pid: number;
  alive = true;
  output = '';
  readonly exited: Promise<ExitInfo>;
  #settle!: (info: ExitInfo) => void;

  constructor(pid: number) {
    this.pid = pid;
    this.exited = new Promise<ExitInfo>((resolve) => {
      this.#settle = resolve;
    });
  }

  exit(code: number | null = 0): void {
    if (!this.alive) return;
    this.alive = false;
    this.#settle({ code, signal: null });
  }

  recentOutput(): string {
    return this.output;
  }
}

export interface Harness {
  specs: LaunchSpec[];
  processes: FakeProcess[];
  terminations: { pid: number; mode: TerminationMode }[];
  /** When false, a graceful termination is ignored and only force works. */
  gracefulWorks: boolean;
  /** When false, even a forced termination leaves the process alive. */
  forceWorks: boolean;
  healthy: boolean;
  launch: (spec: LaunchSpec) => LaunchedProcess;
  terminateTree: (pid: number, mode: TerminationMode) => Promise<void>;
  processExists: (pid: number) => boolean;
  fetch: typeof globalThis.fetch;
  inspector: ProcessInspector;
  last(): FakeProcess;
  /** Resolves once `count` processes have been launched. */
  waitForProcess(count?: number): Promise<FakeProcess>;
}

export function createHarness(): Harness {
  const specs: LaunchSpec[] = [];
  const processes: FakeProcess[] = [];
  const terminations: { pid: number; mode: TerminationMode }[] = [];
  let nextPid = 41000;

  const harness: Harness = {
    specs,
    processes,
    terminations,
    gracefulWorks: true,
    forceWorks: true,
    healthy: true,

    launch(spec: LaunchSpec): LaunchedProcess {
      specs.push(spec);
      const created = new FakeProcess(nextPid);
      nextPid += 1;
      processes.push(created);
      return created as unknown as LaunchedProcess;
    },

    async terminateTree(pid: number, mode: TerminationMode): Promise<void> {
      terminations.push({ pid, mode });
      const target = processes.find((entry) => entry.pid === pid);
      if (!target) return;
      if (mode === 'force' ? harness.forceWorks : harness.gracefulWorks) target.exit(0);
    },

    processExists(pid: number): boolean {
      return processes.find((entry) => entry.pid === pid)?.alive ?? false;
    },

    fetch: (async () => {
      if (!harness.healthy) throw new Error('connection refused');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof globalThis.fetch,

    inspector: {
      async inspect(pid: number): Promise<ProcessIdentity | null> {
        const found = processes.find((entry) => entry.pid === pid && entry.alive);
        return found ? { pid, commandLine: 'fake-arm --port 1', startedAtMs: 1_700_000_000_000 } : null;
      },
    },

    last(): FakeProcess {
      const found = processes.at(-1);
      if (!found) throw new Error('no process has been launched');
      return found;
    },

    async waitForProcess(count = 1): Promise<FakeProcess> {
      const deadline = Date.now() + 2000;
      while (processes.length < count) {
        if (Date.now() > deadline) throw new Error(`only ${processes.length} processes were launched`);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return processes[count - 1] as FakeProcess;
    },
  };

  return harness;
}
