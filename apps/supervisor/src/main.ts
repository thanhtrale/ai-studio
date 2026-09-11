import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArmManager } from './arm-manager.js';
import { ConfigError, loadConfig } from './config.js';
import { GpuSampler } from './gpu.js';
import { JobStore } from './jobs.js';
import { createControlServer } from './server.js';

const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

function loadDotEnv(): void {
  const envFile = path.join(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

async function main(): Promise<void> {
  loadDotEnv();

  const config = loadConfig(process.env, ROOT_DIR);
  const manager = new ArmManager(config);
  const jobs = new JobStore();
  // Started before any arm, so the console can show what the card held before
  // this studio touched it -- which is most of the gap between the two meters.
  const gpu = new GpuSampler();
  gpu.start();

  console.log(`[supervisor] arms:    ${config.armsDir}`);
  console.log(`[supervisor] storage: ${config.storageDir}`);
  console.log('[supervisor] reconciling previously launched processes...');
  await manager.init();

  const server = createControlServer(config, { manager, jobs, gpu });
  server.listen(config.port, config.host, () => {
    console.log(`[supervisor] listening on http://${config.host}:${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[supervisor] ${signal} received, stopping arms`);
    server.close();
    gpu.stop();
    await manager.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[supervisor] configuration error: ${error.message}`);
    process.exit(78);
  }
  console.error('[supervisor] fatal:', error);
  process.exit(1);
});
