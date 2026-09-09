import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#records, null, 2)}\n`, 'utf8');
    await rename(temporary, this.#file);
  }
}

export function buildCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}
