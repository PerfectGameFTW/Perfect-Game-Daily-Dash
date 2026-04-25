import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['server/tests/**/*.test.ts'],
    // Redirect every test-file import of `server/db` at the isolated
    // test database BEFORE the first import resolves (Task #106).
    // setup.ts only mutates process.env — it does not import any
    // server modules itself, so the load order is safe.
    setupFiles: ['./server/tests/setup.ts'],
  },
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, './shared'),
      '@server': resolve(__dirname, './server')
    }
  }
});