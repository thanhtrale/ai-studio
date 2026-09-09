import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';

// Config and credentials live in the repository root .env, not in apps/web.
const rootEnv = path.resolve(fileURLToPath(import.meta.url), '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const supervisorHost = process.env['AISTUDIO_SUPERVISOR_HOST'] ?? '127.0.0.1';
const supervisorPort = process.env['AISTUDIO_SUPERVISOR_PORT'] ?? '4319';

export default defineNuxtConfig({
  compatibilityDate: '2026-09-09',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  // listhen generates a self-signed certificate, so a clean checkout needs no
  // certificate files of its own.
  devServer: {
    https: true,
    host: '127.0.0.1',
    port: 3000,
  },
  // Not under `public`: these stay on the server and never reach the browser.
  runtimeConfig: {
    supervisorUrl: `http://${supervisorHost}:${supervisorPort}`,
    supervisorToken: process.env['AISTUDIO_SUPERVISOR_TOKEN'] ?? '',
  },
});
