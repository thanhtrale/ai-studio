import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';

// Config and credentials live in the repository root .env, not in apps/web.
const rootEnv = path.resolve(fileURLToPath(import.meta.url), '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const supervisorHost = process.env['AISTUDIO_SUPERVISOR_HOST'] ?? '127.0.0.1';
const supervisorPort = process.env['AISTUDIO_SUPERVISOR_PORT'] ?? '4319';

// The library reads and writes the same managed storage directory the supervisor
// resolves arm paths against. It is reached directly rather than through the
// supervisor because listing files and streaming bytes is not an arm operation,
// and relaying them through a second process would buy nothing.
const storageDir = path.resolve(
  fileURLToPath(import.meta.url),
  '../../..',
  process.env['AISTUDIO_STORAGE_DIR'] ?? './storage',
);

export default defineNuxtConfig({
  compatibilityDate: '2026-09-09',
  devtools: { enabled: false },
  // Universal, not a single-page app: every page renders on the server first and
  // every view the user can arrive at has a URL of its own.
  ssr: true,
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  // Plain http on the loopback interface. The self-signed certificate listhen
  // generates cost a browser warning on every fresh profile and bought nothing
  // here: nothing leaves this machine, and no API this console uses is gated
  // behind a secure context.
  devServer: {
    host: '127.0.0.1',
    port: 3000,
  },
  // Not under `public`: these stay on the server and never reach the browser.
  runtimeConfig: {
    supervisorUrl: `http://${supervisorHost}:${supervisorPort}`,
    supervisorToken: process.env['AISTUDIO_SUPERVISOR_TOKEN'] ?? '',
    storageDir,
  },
});
