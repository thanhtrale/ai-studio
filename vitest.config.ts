import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      'packages/*',
      'apps/*',
      // Keeps at least one project resolvable before any workspace package exists.
      {
        test: {
          name: 'workspace-root',
          root: import.meta.dirname,
          include: ['tests/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
    ],
  },
});
