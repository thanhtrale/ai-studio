import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArmManager } from './arm-manager.js';
import { ConfigError, loadConfig } from './config.js';
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

  console.log(`[supervisor] arms:    ${config.armsDir}`);
  console.log(`[supervisor] storage: ${config.storageDir}`);
  console.log('[supervisor] reconciling previously launched processes...');
  await manager.init();

  const server = createControlServer(config, manager);
  server.listen(config.port, config.host, () => {
    console.log(`[supervisor] listening on http://${config.host}:${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[supervisor] ${signal} received, stopping arms`);
    server.close();
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
