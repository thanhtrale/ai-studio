import path from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  // Nuxt supplies #shared at build time; the tests run without Nuxt, so the
  // alias has to be repeated here or every shared import resolves to nothing.
  resolve: {
    alias: { '#shared': path.resolve(import.meta.dirname, 'shared') },
  },
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['app/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});
