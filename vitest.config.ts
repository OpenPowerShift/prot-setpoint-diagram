import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '~': resolve(here, 'src'),
    },
  },
  server: {
    fs: {
      strict: false,
      allow: [here, resolve(here, 'src'), resolve(here, 'tests')],
    },
  },
});
