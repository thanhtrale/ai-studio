import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { GpuTelemetry, VramSample } from '@ai-studio/arm-contract';

/**
 * Whole-card memory, once a second, for as long as the supervisor is up.
 *
 * This is the second of the two meters the console draws, and deliberately not
 * the same measurement as the arm's. An arm reports what torch reserved inside
 * one process; this reports what the card holds, which includes the desktop, the
 * browser's own compositor, and anything the driver keeps. Neither is derivable
 * from the other, so both are shown.
 */

const MIB_PER_GIB = 1024;
/** Half an hour at one sample a second. Older than that is not worth drawing. */
const WINDOW_SAMPLES = 1800;
const RESTART_DELAY_MS = 5000;

/** One process for the whole run rather than one per second. */
const QUERY = 'timestamp,index,memory.used,memory.total';

/** Stdin is closed and both output streams are pipes, which fixes the shape. */
type SmiProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface GpuSamplerDeps {
  spawnImpl?: typeof spawn;
  now?: () => number;
}

export class GpuSampler {
  readonly #deps: Required<GpuSamplerDeps>;
  #samples: VramSample[] = [];
  #totalGib: number | null = null;
  #child: SmiProcess | null = null;
  #pending = '';
  #available = false;
  #stopped = false;
  #restart: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: GpuSamplerDeps = {}) {
    this.#deps = { spawnImpl: deps.spawnImpl ?? spawn, now: deps.now ?? Date.now };
  }

  get available(): boolean {
    return this.#available;
  }

  start(): void {
    if (this.#stopped || this.#child) return;

    let child: SmiProcess;
    try {
      child = this.#deps.spawnImpl(
        'nvidia-smi',
        ['--query-gpu=' + QUERY, '--format=csv,noheader,nounits', '--loop=1'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      // No driver tooling on this machine. The console shows the arm's own
      // figure alone and says the machine meter is unavailable.
      this.#available = false;
      return;
    }

    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#consume(chunk));
    child.on('error', () => this.#down());
    child.on('exit', () => this.#down());
  }

  #down(): void {
    this.#available = false;
    this.#child = null;
    this.#pending = '';
    if (this.#stopped || this.#restart) return;

    this.#restart = setTimeout(() => {
      this.#restart = null;
      this.start();
    }, RESTART_DELAY_MS);
    this.#restart.unref?.();
  }

  #consume(chunk: string): void {
    this.#pending += chunk;
    const lines = this.#pending.split(/\r?\n/);
    this.#pending = lines.pop() ?? '';
    for (const line of lines) this.ingest(line);
  }

  /**
   * One CSV row: `2026/09/11 12:34:56.789, 0, 2048, 16376`.
   *
   * The timestamp is nvidia-smi's own rather than the time this arrived. If the
   * pipe ever delivers a second's worth of rows in one chunk, the series still
   * has the shape the card actually had instead of a vertical cliff.
   */
  ingest(line: string): void {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 4) return;

    const [stamp, index, used, total] = parts as [string, string, string, string];
    if (index !== '0') return; // Device 0 is the card arms are placed on.

    const usedMib = Number(used);
    const totalMib = Number(total);
    if (!Number.isFinite(usedMib) || !Number.isFinite(totalMib)) return;

    const parsed = Date.parse(stamp.replace(/\//g, '-').replace(' ', 'T'));
    this.#totalGib = totalMib / MIB_PER_GIB;
    this.#available = true;

    this.#samples.push({
      at: Number.isFinite(parsed) ? parsed : this.#deps.now(),
      gib: usedMib / MIB_PER_GIB,
    });
    if (this.#samples.length > WINDOW_SAMPLES) {
      this.#samples = this.#samples.slice(-WINDOW_SAMPLES);
    }
  }

  telemetry(since?: number): GpuTelemetry {
    const samples = since === undefined ? this.#samples : this.#samples.filter((s) => s.at >= since);
    return { totalGib: this.#totalGib, available: this.#available, samples: [...samples] };
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restart) clearTimeout(this.#restart);
    this.#restart = null;
    this.#child?.kill();
    this.#child = null;
  }
}
