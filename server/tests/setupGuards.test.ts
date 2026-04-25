/**
 * Regression coverage for the two hard-fail safety guards added by
 * Task #106 in `server/tests/setup.ts`:
 *
 *   1. Refuse to start if neither TEST_DATABASE_URL is set nor a
 *      `<live>_test` URL can be derived from DATABASE_URL.
 *   2. Refuse to start if the resolved test URL is byte-equal to
 *      DATABASE_URL.
 *
 * Without this file, a future refactor that swaps either `throw` for
 * (e.g.) a `console.warn` fallback to the live DB would silently let
 * the entire suite hammer production rows. We can't assert that from
 * inside the same vitest invocation that already passed setup, so we
 * spawn a fresh `vitest run` subprocess per misconfigured env shape
 * and assert: non-zero exit code AND the canonical guard message in
 * the combined stdio.
 *
 * The subprocess is pointed at `setupGuardProbe.test.ts`, a
 * deliberate no-op. Using a DB-touching test would let a future
 * regression that swaps `throw` for `console.warn` still exit
 * non-zero via downstream DB errors, falsely satisfying the
 * `not.toBe(0)` assertion. With a no-op probe, the only thing
 * that can cause a non-zero subprocess exit is the guard itself.
 * We additionally pin causality by asserting the combined output
 * contains `server/tests/setup.ts` (the throw site).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';

const VITEST_BIN = resolve(process.cwd(), 'node_modules/.bin/vitest');
// Deliberately a no-op probe (see server/tests/setupGuardProbe.test.ts):
// using a DB-touching test here would let a future regression that
// weakens `throw` to `console.warn` still exit non-zero via downstream
// DB errors, falsely satisfying our `not.toBe(0)` assertion.
const PROBE_TEST_TARGET = 'server/tests/setupGuardProbe.test.ts';

function spawnVitestWithEnv(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(
    VITEST_BIN,
    ['run', PROBE_TEST_TARGET, '--reporter=basic', '--no-color'],
    {
      env,
      encoding: 'utf-8',
      // Vitest cold-start + setup throw + teardown is well under 60s
      // even on a slow Replit container; cap at 90s to be safe.
      timeout: 90_000,
      cwd: process.cwd(),
    },
  );
}

describe('vitest test-DB safety guards (regression for Task #106)', () => {
  it(
    'refuses to start when TEST_DATABASE_URL is unset and DATABASE_URL is unset',
    () => {
      const env = { ...process.env };
      delete env.TEST_DATABASE_URL;
      delete env.DATABASE_URL;

      const result = spawnVitestWithEnv(env);

      expect(result.error, `spawn error: ${result.error?.message}`).toBeUndefined();
      expect(result.status, `expected non-zero exit, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);

      const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(combined).toContain(
        'Test setup refused to start: TEST_DATABASE_URL is not set',
      );
      // Belt-and-suspenders: pin the failure to setup.ts itself, so a
      // future db.ts-level error (e.g. "DATABASE_URL must be set")
      // cannot be mistaken for our guard firing.
      expect(combined).toContain('server/tests/setup.ts');
    },
    120_000,
  );

  it(
    'refuses to start when TEST_DATABASE_URL equals DATABASE_URL',
    () => {
      // Use a syntactically valid Postgres URL that points at an
      // unroutable sentinel host — the guard fires before any
      // connection is attempted, so the host never has to resolve.
      const sameUrl =
        'postgresql://guarduser:guardpass@safety-guard.invalid:5432/regression_db';
      const env = {
        ...process.env,
        DATABASE_URL: sameUrl,
        TEST_DATABASE_URL: sameUrl,
      };

      const result = spawnVitestWithEnv(env);

      expect(result.error, `spawn error: ${result.error?.message}`).toBeUndefined();
      expect(result.status, `expected non-zero exit, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);

      const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(combined).toContain(
        'resolves to the same connection string as DATABASE_URL',
      );
      // Belt-and-suspenders: pin the failure to setup.ts itself, so a
      // future db.ts-level error cannot be mistaken for our guard firing.
      expect(combined).toContain('server/tests/setup.ts');
    },
    120_000,
  );
});
