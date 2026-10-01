import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';

// Firebase keys live in frontend/.env; fall back to the repository root .env so a
// single file can configure the whole monorepo.
for (const candidate of ['../.env', '../../.env']) {
  const file = path.resolve(fileURLToPath(import.meta.url), candidate);
  if (existsSync(file)) process.loadEnvFile(file);
}

export default defineNuxtConfig({
  compatibilityDate: '2026-09-09',
  devtools: { enabled: false },

  // No server rendering: `nuxt generate` emits a static bundle that Firebase
  // Hosting serves as-is, and the router takes over in the browser.
  ssr: false,

  nitro: {
    preset: 'static',
  },

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  devServer: {
    host: '127.0.0.1',
    port: 3100,
  },

  app: {
    head: {
      htmlAttrs: { lang: 'vi' },
      link: [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    },
  },

  // Public: these are baked into the generated bundle and are visible to the
  // browser. Firebase web config is not a secret — access is gated by Storage
  // rules, not by hiding these values.
  runtimeConfig: {
    public: {
      firebase: {
        apiKey: process.env['NUXT_PUBLIC_FIREBASE_API_KEY'] ?? '',
        authDomain: process.env['NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN'] ?? '',
        projectId: process.env['NUXT_PUBLIC_FIREBASE_PROJECT_ID'] ?? '',
        storageBucket: process.env['NUXT_PUBLIC_FIREBASE_STORAGE_BUCKET'] ?? '',
        messagingSenderId: process.env['NUXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'] ?? '',
        appId: process.env['NUXT_PUBLIC_FIREBASE_APP_ID'] ?? '',
      },
      storagePrefix: process.env['NUXT_PUBLIC_STORAGE_PREFIX'] ?? 'uploads',
    },
  },
});
