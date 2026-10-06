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
  /**
   * Set when the process never started or could not be managed -- a command
   * that is not there (ENOENT), one that may not be executed. Carried here
   * rather than as a rejection: `exited` is watched from several places with
   * a bare `.then`, and a rejection none of them caught took the whole
   * supervisor down the first time an arm's interpreter was missing.
   */
  error?: Error;
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

  // Never rejects. Whichever of `error` and `exit` comes first settles it; a
  // spawn that fails emits `error` and no `exit` at all.
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    pid: child.pid ?? -1,
    child,
    exited,
    recentOutput: () => output.toString(),
  };
}
