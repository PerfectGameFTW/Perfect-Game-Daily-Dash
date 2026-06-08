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
    // After the suite, audit the test DB and warn loudly if any test
    // left rows behind (Task #138). Runs ONCE per `vitest run`, after
    // every worker has exited. The audit never fails the build — it
    // emits a banner-bracketed warning on stderr and exits 0.
    globalTeardown: ['./server/tests/globalTeardown.ts'],
    // Run test FILES one at a time (each still isolated in its own fork).
    // Every file shares the single sibling `<live>_test` database, and
    // several exercise GLOBAL singleton rows in `app_settings` — most
    // notably the deployment-wide require-admin-2FA toggle, which (when a
    // file flips it on) makes requireAuth reject EVERY admin-authenticated
    // request with 403 TOTP_ENROLLMENT_REQUIRED. With file-level
    // parallelism, one file's transient writes to those singleton rows
    // bleed into any other file running at the same moment, producing
    // non-deterministic 403s and stale-read failures whose victim changes
    // run-to-run. Per-file cleanup can't close the gap — the "on" window
    // overlaps concurrent files by construction. globalSetup already
    // assumes a single logical run (it truncates once and serializes
    // separate runs via an advisory lock), so serializing files within a
    // run is consistent with that design and removes the shared-state race
    // class entirely.
    //
    // Exit criterion: this can be lifted (restoring file parallelism) once
    // test isolation no longer relies on a single shared DB with mutable
    // global singletons — e.g. per-file database/schema isolation, or fully
    // namespaced `app_settings` keys per file.
    fileParallelism: false,
  },
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, './shared'),
      '@server': resolve(__dirname, './server')
    }
  }
});