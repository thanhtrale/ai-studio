import { describe, expect, it } from 'vitest';

import { GpuSampler } from './gpu.js';

const row = (stamp: string, used: number, index = 0, total = 16376): string =>
  `${stamp}, ${index}, ${used}, ${total}`;

describe('GpuSampler', () => {
  it('reads a row into a sample carrying the card total', () => {
    const sampler = new GpuSampler();
    sampler.ingest(row('2026/09/11 12:34:56.789', 2048));

    const telemetry = sampler.telemetry();
    expect(telemetry.available).toBe(true);
    expect(telemetry.totalGib).toBeCloseTo(15.992, 3);
    expect(telemetry.samples).toHaveLength(1);
    expect(telemetry.samples[0]?.gib).toBeCloseTo(2, 5);
  });

  it("uses nvidia-smi's own timestamp, so a batched pipe keeps the real shape", () => {
    const sampler = new GpuSampler({ now: () => 0 });
    sampler.ingest(row('2026/09/11 12:34:56.000', 1024));
    sampler.ingest(row('2026/09/11 12:34:57.000', 2048));

    const [first, second] = sampler.telemetry().samples;
    expect(second!.at - first!.at).toBe(1000);
  });

  it('falls back to the clock when the timestamp is unreadable', () => {
    const sampler = new GpuSampler({ now: () => 1_700_000_000_000 });
    sampler.ingest(row('not a date', 1024));

    expect(sampler.telemetry().samples[0]?.at).toBe(1_700_000_000_000);
  });

  it('ignores every card but the one arms are placed on', () => {
    const sampler = new GpuSampler();
    sampler.ingest(row('2026/09/11 12:34:56.000', 9999, 1));

    expect(sampler.telemetry().samples).toEqual([]);
    expect(sampler.available).toBe(false);
  });

  it('ignores a partial or unparseable row rather than recording a zero', () => {
    const sampler = new GpuSampler();
    sampler.ingest('');
    sampler.ingest('2026/09/11 12:34:56.000, 0');
    sampler.ingest(row('2026/09/11 12:34:56.000', Number.NaN));

    expect(sampler.telemetry().samples).toEqual([]);
  });

  it('returns only the window a caller asks for', () => {
    const sampler = new GpuSampler();
    sampler.ingest(row('2026/09/11 12:00:00.000', 1024));
    sampler.ingest(row('2026/09/11 12:00:10.000', 2048));

    const since = Date.parse('2026-09-11T12:00:05.000');
    expect(sampler.telemetry(since).samples).toHaveLength(1);
  });

  it('reports unavailable before anything has been read', () => {
    const sampler = new GpuSampler();

    expect(sampler.telemetry()).toEqual({ totalGib: null, available: false, samples: [] });
  });
});
