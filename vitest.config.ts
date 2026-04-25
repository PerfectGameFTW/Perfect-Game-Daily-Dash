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
    // Truncate every public table in the test DB once before the suite
    // starts so orphan rows from prior aborted runs can't leak across
    // CI invocations (Task #136). Runs ONCE per `vitest run`, in the
    // main process, before any worker is spawned.
    globalSetup: ['./server/tests/globalSetup.ts'],
  },
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, './shared'),
      '@server': resolve(__dirname, './server')
    }
  }
});