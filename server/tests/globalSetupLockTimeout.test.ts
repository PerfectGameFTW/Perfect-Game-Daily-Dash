/**
 * Regression coverage for the lock-wait escape hatch in
 * server/tests/globalSetup.ts (Tasks #139/#140/#143).
 *
 * Why this test exists:
 *   globalSetup pins `lock_timeout` on the lock-holding session via
 *
 *     SET lock_timeout = ${LOCK_WAIT_TIMEOUT_MS}
 *
 *   so that a queued `vitest run` blocked behind a genuinely-frozen
 *   previous run surfaces a clear Postgres error
 *   ("canceling statement due to lock timeout") after fifteen minutes
 *   instead of hanging the post-merge hook indefinitely. The
 *   wait-visibility test (Task #142) covers the
 *   "Waiting / still waiting / Lock acquired" output but does NOT
 *   cover the escape hatch itself: a future refactor that drops the
 *   `SET lock_timeout = …` line (e.g. someone deciding the explicit
 *   timeout is "noise") would silently regress us back to unbounded
 *   hangs with no failing test.
 *
 *   This test re-uses the Task #142 lock-key + heartbeat hooks plus a
 *   new Task #143 hook that shrinks the timeout from 15 minutes to a
 *   couple of seconds, then holds a contended lock indefinitely and
 *   asserts the spawned child globalSetup exits non-zero with the
 *   canonical Postgres lock-timeout message on its stderr.
 *
 * Why a wall-clock cap matters here:
 *   The hook only changes the *value* fed into `SET lock_timeout`. If
 *   a future refactor removes the SET statement entirely (or pegs it
 *   at zero / `-1` / MAX_SAFE_INTEGER, all of which Postgres treats as
 *   "no timeout"), the override is irrelevant and the child will hang
 *   forever on `pg_advisory_lock`. We therefore arm a generous-but-
 *   bounded wall-clock timeout below: if the child does not exit on
 *   its own within that window, we kill it and fail the test, which
 *   is exactly the regression signal Task #143 asks for.
 *
 * Safety:
 *   The child runs with `IS_TESTHOOK_ACTIVE` set (because we override
 *   the lock key), which short-circuits the destructive TRUNCATE in
 *   globalSetup. The child also never reaches the post-lock branch in
 *   this test because the lock acquisition is the very statement that
 *   times out — but the safety still holds either way.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { LOCK_WAIT_TIMEOUT_MS_DEFAULT } from './globalSetup';

neonConfig.webSocketConstructor = ws;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MUST match the constant in server/tests/globalSetup.ts. Hardcoded
// (not imported) so a future change to the high half of the lock key
// fails this test loudly instead of being silently mirrored.
const LOCK_KEY_HI = 0x7e57db;

// Test-only lock key, distinct from the suite's main lock (139) and
// from the wait-visibility test's lock (142). Chosen as the
// originating task number (143) so future readers can trace it back.
const TEST_LOCK_KEY_LO = 143;

// Shrunk lock_timeout for the child globalSetup. Two seconds is
// long enough that a momentarily-slow Postgres round-trip cannot
// trip the timeout spuriously, but short enough that the test
// completes quickly even on CI.
const TEST_LOCK_TIMEOUT_MS = 2_000;

// Heartbeat cadence for the child's "still waiting (Ns)" output.
// Kept short so it doesn't dominate the bounded wait above; the
// content of those lines is not what this test asserts on.
const TEST_HEARTBEAT_MS = 500;

// Hard wall-clock cap on how long the child is allowed to take. If
// the SET lock_timeout statement is removed in a future refactor,
// `pg_advisory_lock` will block indefinitely; we use this cap to
// detect that and fail. Comfortably larger than TEST_LOCK_TIMEOUT_MS
// so a healthy run never races against it.
const CHILD_EXIT_BUDGET_MS = 20_000;

// Resolved test database URL. setup.ts has already replaced
// process.env.DATABASE_URL with the test URL by the time test files
// load, so DATABASE_URL here IS the test DB.
const TEST_DB_URL = process.env.DATABASE_URL!;

// Probe pool used to hold the contended lock. Single-connection so
// the lock-holding session is unambiguous; the same client must
// release the lock it acquired (Postgres advisory locks are
// session-scoped).
const probePool = new Pool({
  connectionString: TEST_DB_URL,
  connectionTimeoutMillis: 10_000,
  max: 1,
});

afterAll(async () => {
  await probePool.end().catch(() => {});
});

describe('globalSetup lock-wait timeout escape hatch (regression for Task #143)', () => {
  // The contended-run subprocess test below uses a shrunk override
  // (TEST_LOCK_TIMEOUT_MS) for speed, which means a future refactor
  // that changes only the *default* — e.g. from 15 minutes to
  // Number.MAX_SAFE_INTEGER, `0` ("no timeout" in Postgres), or
  // `-1` — would still pass that test because the override would
  // mask the regression. Pin the production default here so any
  // such change has to go through this assertion.
  //
  // Updating the default to a different finite value is a
  // deliberate operator decision; if you need to do it, change
  // both the constant in server/tests/globalSetup.ts and the
  // expected value below in the same commit so the rationale shows
  // up in code review.
  it('keeps the production lock-wait timeout pinned at 15 minutes', () => {
    expect(LOCK_WAIT_TIMEOUT_MS_DEFAULT).toBe(15 * 60 * 1000);
  });

  it('aborts the queued run with a Postgres lock-timeout error instead of hanging forever', async () => {
    // Step 1: hold the test-controlled advisory lock from a fresh
    // session. The child globalSetup, redirected at this same key by
    // the hook env var, will contend with us — and only with us —
    // and never observe a release.
    const lockClient = await probePool.connect();
    let lockHeld = false;
    let child: ChildProcess | null = null;
    let exitTimer: NodeJS.Timeout | null = null;

    try {
      const acquireResult = await lockClient.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [LOCK_KEY_HI, TEST_LOCK_KEY_LO],
      );
      expect(acquireResult.rows[0]?.acquired).toBe(true);
      lockHeld = true;

      // Step 2: spawn the child. We invoke tsx directly via Node so
      // we don't depend on `npx` being on PATH at test time. The
      // child's globalSetup has two safety guards that refuse to run
      // if the resolved test URL would equal DATABASE_URL; we
      // satisfy them by stripping DATABASE_URL from the child's env
      // entirely and passing the test URL only as TEST_DATABASE_URL.
      const tsxBin = resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
      const wrapperPath = resolve(__dirname, '_runGlobalSetupChild.ts');

      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.DATABASE_URL;
      childEnv.TEST_DATABASE_URL = TEST_DB_URL;
      childEnv.VITEST_GLOBALSETUP_TESTHOOK_LOCK_KEY_LO = String(TEST_LOCK_KEY_LO);
      childEnv.VITEST_GLOBALSETUP_TESTHOOK_WAIT_HEARTBEAT_MS =
        String(TEST_HEARTBEAT_MS);
      childEnv.VITEST_GLOBALSETUP_TESTHOOK_LOCK_TIMEOUT_MS =
        String(TEST_LOCK_TIMEOUT_MS);

      child = spawn(process.execPath, [tsxBin, wrapperPath], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderrBuf = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });
      // Drain stdout to avoid backpressure even though we don't read it.
      child.stdout!.on('data', () => {});

      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit) => {
        child!.on('exit', (code, signal) => resolveExit({ code, signal }));
      });

      // Step 3: bounded wait for the child to exit on its own. If the
      // SET lock_timeout statement is removed in a future refactor,
      // pg_advisory_lock will block forever; the timeout below is the
      // signal that the regression has occurred.
      const exitInfo = await Promise.race([
        exitPromise,
        new Promise<never>((_, rejectTimeout) => {
          exitTimer = setTimeout(() => {
            rejectTimeout(
              new Error(
                `child globalSetup did not exit within ${CHILD_EXIT_BUDGET_MS}ms ` +
                  `while a contended advisory lock was held — the lock-wait ` +
                  `escape hatch (SET lock_timeout) appears to be missing or ` +
                  `effectively-infinite.\nstderr so far:\n${stderrBuf}`,
              ),
            );
          }, CHILD_EXIT_BUDGET_MS);
        }),
      ]);

      // Step 4: the child must exit non-zero (the wrapper rethrows
      // globalSetup's error and exits with code 1) and stderr must
      // include the canonical Postgres lock-timeout message. Both
      // assertions are needed: a non-zero exit alone could come from
      // any unrelated failure (e.g. the safety guards refusing to
      // run), and the message alone could in principle land on a
      // path that still exits 0.
      expect(exitInfo.signal).toBe(null);
      expect(exitInfo.code).not.toBe(0);
      expect(stderrBuf).toMatch(/canceling statement due to lock timeout/);
      // And the child must have entered the contended branch at all
      // — otherwise the lock dance was never exercised and the
      // assertion above could be satisfied by some other code path.
      expect(stderrBuf).toMatch(
        /\[globalSetup\] Waiting for another vitest run to release the test-DB lock/,
      );
    } finally {
      if (exitTimer) clearTimeout(exitTimer);
      if (lockHeld) {
        await lockClient
          .query('SELECT pg_advisory_unlock($1, $2)', [
            LOCK_KEY_HI,
            TEST_LOCK_KEY_LO,
          ])
          .catch(() => {});
      }
      try {
        lockClient.release();
      } catch {
        /* ignore */
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 60_000);
});
