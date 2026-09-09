import type { ProcessInspector } from './process-inspector.js';
import type { LaunchRecord } from './registry.js';

export type ReconcileAction = 'adopt' | 'discard' | 'terminate';

export interface ReconcileDecision {
  record: LaunchRecord;
  action: ReconcileAction;
  reason: string;
}

export interface ReconcileInput {
  records: readonly LaunchRecord[];
  inspector: ProcessInspector;
  /** Ids the current inventory still knows about. */
  knownArmIds: ReadonlySet<string>;
}

const START_TIME_TOLERANCE_MS = 2000;

function identityMatches(record: LaunchRecord, commandLine: string, startedAtMs: number): boolean {
  if (record.commandLine && commandLine && !commandLine.includes(record.commandLine.split(' ')[0] ?? '')) {
    return false;
  }

  if (record.processStartedAtMs !== null && startedAtMs > 0) {
    return Math.abs(record.processStartedAtMs - startedAtMs) <= START_TIME_TOLERANCE_MS;
  }

  // Without a recorded creation time the command line is all we have.
  return record.commandLine.length > 0 && commandLine.includes(record.commandLine.split(' ')[0] ?? '');
}

/**
 * Decides what to do with each process the supervisor recorded before it died.
 *
 * A pid can be recycled by an unrelated program, so a live pid is never trusted
 * on its own: the record is only honoured when the process still looks like the
 * arm that was launched. A foreign process is left strictly alone.
 */
export async function reconcile({
  records,
  inspector,
  knownArmIds,
}: ReconcileInput): Promise<ReconcileDecision[]> {
  const decisions: ReconcileDecision[] = [];

  for (const record of records) {
    const identity = await inspector.inspect(record.pid);

    if (identity === null) {
      decisions.push({ record, action: 'discard', reason: 'process is no longer running' });
      continue;
    }

    if (!identityMatches(record, identity.commandLine, identity.startedAtMs)) {
      decisions.push({
        record,
        action: 'discard',
        reason: `pid ${record.pid} now belongs to an unrelated process`,
      });
      continue;
    }

    if (!knownArmIds.has(record.armId)) {
      decisions.push({
        record,
        action: 'terminate',
        reason: `arm "${record.armId}" is no longer in the inventory`,
      });
      continue;
    }

    decisions.push({ record, action: 'adopt', reason: 'process matches the recorded launch' });
  }

  return decisions;
}
