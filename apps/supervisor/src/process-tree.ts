import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TerminationMode = 'graceful' | 'force';

export function processExists(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Terminates a process together with everything it spawned.
 *
 * Killing only the arm's own pid is not enough: a Python arm's dataloader
 * workers or a ComfyUI subprocess would survive and keep the GPU allocation,
 * which is the whole reason stopping an arm exists.
 *
 * On POSIX this relies on arms being launched detached, which makes each arm
 * its own process-group leader, so the negative pid reaches the group. Windows
 * has no process groups usable from Node without a native Job Object binding,
 * so `taskkill /T` walks the parent/child tree instead.
 */
export async function terminateTree(pid: number, mode: TerminationMode): Promise<void> {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (mode === 'force') args.push('/F');
    try {
      await execFileAsync('taskkill', args, { windowsHide: true });
    } catch (error) {
      // Exit code 128 means the process is already gone, which is success here.
      const code = (error as { code?: number }).code;
      if (code !== 128 && processExists(pid)) throw error;
    }
    return;
  }

  const signal = mode === 'force' ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    // Fall back to the bare pid when the arm was not a group leader.
    try {
      process.kill(pid, signal);
    } catch (innerError) {
      if ((innerError as NodeJS.ErrnoException).code !== 'ESRCH') throw innerError;
    }
  }
}
