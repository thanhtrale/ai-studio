import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';

export type ArmChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface LaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LaunchedProcess {
  pid: number;
  child: ArmChildProcess;
  exited: Promise<ExitInfo>;
  recentOutput(): string;
}

const MAX_OUTPUT_LINES = 200;

class OutputRing {
  readonly #lines: string[] = [];

  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.#lines.push(line);
      if (this.#lines.length > MAX_OUTPUT_LINES) this.#lines.shift();
    }
  }

  toString(): string {
    return this.#lines.join('\n');
  }
}

/**
 * Starts an arm process.
 *
 * `shell: false` is the point of this function: the command and every argument
 * come from a manifest on disk as separate argv entries, so no value is ever
 * handed to a command interpreter for re-parsing.
 */
export function launch(spec: LaunchSpec): LaunchedProcess {
  const cwd = path.resolve(spec.cwd);

  const child = spawn(spec.command, [...spec.args], {
    cwd,
    env: { ...process.env, ...spec.env },
    shell: false,
    windowsHide: true,
    // Makes the arm a process-group leader on POSIX so the whole group can be
    // signalled later. Windows uses taskkill /T instead.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = new OutputRing();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => output.push(chunk));
  child.stderr.on('data', (chunk: string) => output.push(chunk));

  const exited = new Promise<ExitInfo>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    pid: child.pid ?? -1,
    child,
    exited,
    recentOutput: () => output.toString(),
  };
}
