import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface SupervisorConfig {
  host: string;
  port: number;
  token: string;
  armsDir: string;
  storageDir: string;
  stateDir: string;
  /** How long a stopping arm is given to exit before it is force-killed. */
  stopGraceMs: number;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is not set - copy .env.example to .env and fill it in`);
  return value;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = process.cwd(),
): SupervisorConfig {
  const host = env['AISTUDIO_SUPERVISOR_HOST']?.trim() || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `AISTUDIO_SUPERVISOR_HOST must be a loopback address, received "${host}". ` +
        'The supervisor can start arbitrary local processes and is never exposed off-host.',
    );
  }

  const port = Number.parseInt(env['AISTUDIO_SUPERVISOR_PORT']?.trim() || '4319', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`AISTUDIO_SUPERVISOR_PORT must be a valid port, received "${env['AISTUDIO_SUPERVISOR_PORT']}"`);
  }

  const token = required(env, 'AISTUDIO_SUPERVISOR_TOKEN');
  if (token.length < 16) {
    throw new ConfigError('AISTUDIO_SUPERVISOR_TOKEN must be at least 16 characters');
  }

  const storageDir = path.resolve(rootDir, env['AISTUDIO_STORAGE_DIR']?.trim() || './storage');

  return {
    host,
    port,
    token,
    armsDir: path.resolve(rootDir, env['AISTUDIO_ARMS_DIR']?.trim() || './arms'),
    storageDir,
    stateDir: path.join(storageDir, 'cache', 'supervisor'),
    stopGraceMs: Number.parseInt(env['AISTUDIO_STOP_GRACE_MS']?.trim() || '10000', 10),
  };
}
