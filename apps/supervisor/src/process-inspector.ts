import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  commandLine: string;
  /** Process creation time, used to detect a recycled pid. */
  startedAtMs: number;
}

export interface ProcessInspector {
  inspect(pid: number): Promise<ProcessIdentity | null>;
}

const WINDOWS_SCRIPT = [
  'Get-CimInstance Win32_Process -Filter "ProcessId=%PID%"',
  'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; start = [int64]($_.CreationDate.ToUniversalTime() - (Get-Date "1970-01-01Z").ToUniversalTime()).TotalMilliseconds } }',
  'ConvertTo-Json -Compress',
].join(' | ');

async function inspectWindows(pid: number): Promise<ProcessIdentity | null> {
  const script = WINDOWS_SCRIPT.replace('%PID%', String(pid));
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );

  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const parsed = JSON.parse(trimmed) as { pid?: number; cmd?: string | null; start?: number };
  if (typeof parsed.pid !== 'number') return null;

  return {
    pid: parsed.pid,
    commandLine: parsed.cmd ?? '',
    startedAtMs: typeof parsed.start === 'number' ? parsed.start : 0,
  };
}

async function inspectPosix(pid: number): Promise<ProcessIdentity | null> {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=,args=']);
  const line = stdout.trim();
  if (!line) return null;

  // `lstart` is a fixed 24-character date such as "Mon Sep  8 16:57:06 2026".
  const startedAt = Date.parse(line.slice(0, 24));
  return {
    pid,
    commandLine: line.slice(24).trim(),
    startedAtMs: Number.isNaN(startedAt) ? 0 : startedAt,
  };
}

export const systemProcessInspector: ProcessInspector = {
  async inspect(pid: number): Promise<ProcessIdentity | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;

    try {
      return process.platform === 'win32' ? await inspectWindows(pid) : await inspectPosix(pid);
    } catch {
      // A non-zero exit means the process is gone or not inspectable.
      return null;
    }
  },
};
