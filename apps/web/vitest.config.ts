import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['app/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
