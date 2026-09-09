import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface LaunchRecord {
  armId: string;
  pid: number;
  /** Supervisor clock at launch. */
  startedAtMs: number;
  /** Process creation time reported by the OS, or null if it could not be read. */
  processStartedAtMs: number | null;
  /** Command and arguments, used to recognise the process after a restart. */
  commandLine: string;
  port: number | null;
}

export const REGISTRY_FILENAME = 'launches.json';

export class LaunchRegistry {
  readonly #file: string;
  #records: LaunchRecord[] = [];
  #writing: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(stateDir, REGISTRY_FILENAME);
  }

  get file(): string {
    return this.#file;
  }

  async load(): Promise<LaunchRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as unknown;
      this.#records = Array.isArray(parsed) ? (parsed as LaunchRecord[]) : [];
    } catch {
      this.#records = [];
    }
    return [...this.#records];
  }

  list(): LaunchRecord[] {
    return [...this.#records];
  }

  async add(record: LaunchRecord): Promise<void> {
    this.#records = [...this.#records.filter((entry) => entry.armId !== record.armId), record];
    await this.#flush();
  }

  async remove(armId: string): Promise<void> {
    const next = this.#records.filter((entry) => entry.armId !== armId);
    if (next.length === this.#records.length) return;
    this.#records = next;
    await this.#flush();
  }

  async replaceAll(records: readonly LaunchRecord[]): Promise<void> {
    this.#records = [...records];
    await this.#flush();
  }

  async #flush(): Promise<void> {
    // Serialised, and with a unique temp name per write: two overlapping
    // flushes would otherwise rename the same temp file and one would fail.
    this.#writing = this.#writing.then(async () => {
      const snapshot = [...this.#records];
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await replaceWithRetry(temporary, this.#file);
    });
    await this.#writing;
  }
}

/**
 * Windows can transiently refuse a replace while another handle is open, so a
 * short retry keeps a routine state write from taking the supervisor down.
 */
async function replaceWithRetry(temporary: string, destination: string, attempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === attempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await rm(temporary, { force: true });
        if (code === 'ENOENT') return;
        throw error;
      }
      await delay(20 * attempt);
    }
  }
}

export function buildCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}
