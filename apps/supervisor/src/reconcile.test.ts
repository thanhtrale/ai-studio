import { describe, expect, it } from 'vitest';

import type { ProcessIdentity, ProcessInspector } from './process-inspector.js';
import { reconcile } from './reconcile.js';
import type { LaunchRecord } from './registry.js';

const STARTED_AT = 1_700_000_000_000;

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    armId: 'text-fake',
    pid: 4242,
    startedAtMs: STARTED_AT,
    processStartedAtMs: STARTED_AT,
    commandLine: 'fake-arm --port 5000',
    port: 5000,
    ...overrides,
  };
}

function inspectorFor(identity: ProcessIdentity | null): ProcessInspector {
  return { inspect: async () => identity };
}

const KNOWN = new Set(['text-fake']);

describe('reconcile', () => {
  it('adopts a process that still matches the recorded launch', async () => {
    const decisions = await reconcile({
      records: [record()],
      inspector: inspectorFor({ pid: 4242, commandLine: 'fake-arm --port 5000', startedAtMs: STARTED_AT }),
      knownArmIds: KNOWN,
    });

    expect(decisions[0]?.action).toBe('adopt');
  });

  it('discards a stale record whose process is gone', async () => {
    const decisions = await reconcile({
      records: [record()],
      inspector: inspectorFor(null),
      knownArmIds: KNOWN,
    });

    expect(decisions[0]?.action).toBe('discard');
    expect(decisions[0]?.reason).toMatch(/no longer running/);
  });

  it('leaves a recycled pid alone instead of killing a foreign process', async () => {
    const decisions = await reconcile({
      records: [record()],
      inspector: inspectorFor({
        pid: 4242,
        commandLine: 'C:\\Windows\\explorer.exe',
        startedAtMs: STARTED_AT + 600_000,
      }),
      knownArmIds: KNOWN,
    });

    expect(decisions[0]?.action).toBe('discard');
    expect(decisions[0]?.reason).toMatch(/unrelated process/);
  });

  it('detects a recycled pid from the creation time even when the command matches', async () => {
    const decisions = await reconcile({
      records: [record()],
      inspector: inspectorFor({
        pid: 4242,
        commandLine: 'fake-arm --port 5000',
        startedAtMs: STARTED_AT + 3_600_000,
      }),
      knownArmIds: KNOWN,
    });

    expect(decisions[0]?.action).toBe('discard');
  });

  it('terminates an adopted process whose arm has left the inventory', async () => {
    const decisions = await reconcile({
      records: [record({ armId: 'removed-arm' })],
      inspector: inspectorFor({ pid: 4242, commandLine: 'fake-arm --port 5000', startedAtMs: STARTED_AT }),
      knownArmIds: KNOWN,
    });

    expect(decisions[0]?.action).toBe('terminate');
  });

  it('decides independently for each record', async () => {
    const inspector: ProcessInspector = {
      async inspect(pid: number) {
        return pid === 1
          ? { pid, commandLine: 'fake-arm --port 5000', startedAtMs: STARTED_AT }
          : null;
      },
    };

    const decisions = await reconcile({
      records: [record({ pid: 1 }), record({ armId: 'other', pid: 2 })],
      inspector,
      knownArmIds: new Set(['text-fake', 'other']),
    });

    expect(decisions.map((decision) => decision.action)).toEqual(['adopt', 'discard']);
  });
});
