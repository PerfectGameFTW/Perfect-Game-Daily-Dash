/**
 * Regression coverage for the queued-run wait-visibility output added
 * in Task #140 to server/tests/globalSetup.ts.
 *
 * Why this test exists:
 *   Task #140 split the previously-monolithic `pg_advisory_lock` call
 *   into a two-phase acquisition (`pg_try_advisory_lock` first,
 *   blocking variant only on miss) so a developer running `npm test`
 *   while another vitest run is mid-flight sees a clear
 *
 *     [globalSetup] Waiting for another vitest run to release …
 *     [globalSetup] still waiting (Ns)…
 *     [globalSetup] Lock acquired after Ns — proceeding with test run.
 *
 *   on stderr instead of a silent multi-minute hang. None of those
 *   lines is verified by any other test, so a future refactor that
 *   collapses the two phases back into a single blocking call (an
 *   easy "simplification" to make) would silently regress us back to
 *   the original silent-hang behavior with no failing test.
 *
 * What this test does:
 *   1. Acquires a *test-controlled* advisory lock from a fresh
 *      Postgres session on the test DB. The lock key is intentionally
 *      different from the suite's own lock key so we never deadlock
 *      against the suite's globalSetup or against unrelated CI runs.
 *   2. Spawns a child process that runs the real globalSetup against
 *      the same test DB, with two test-only env hooks set:
 *        - `VITEST_GLOBALSETUP_TESTHOOK_LOCK_KEY_LO` redirects the
 *          child's lock key to the same one we just acquired (so the
 *          child contends with us, not with the suite).
 *        - `VITEST_GLOBALSETUP_TESTHOOK_WAIT_HEARTBEAT_MS` shortens
 *          the still-waiting heartbeat from 10 seconds to a few
 *          hundred milliseconds so the test does not have to sleep
 *          for ten real seconds just to observe one heartbeat line.
 *      The hooks ALSO suppress the child's destructive TRUNCATE — see
 *      the docstring on the hooks in globalSetup.ts — so this test is
 *      safe to run alongside other tests that have inserted fixtures.
 *   3. Asserts the "Waiting…" and "still waiting (Ns)…" lines appear
 *      on the child's stderr while we hold the lock.
 *   4. Releases the lock and asserts the "Lock acquired after Ns"
 *      line appears and the child exits cleanly with code 0.
 *
 * If a future refactor removes any of those three stderr lines, or
 * collapses the two-phase acquisition back into one blocking call,
 * this test fails on the corresponding assertion.
 *
 * The test exercises the real globalSetup module via a real Node
 * subprocess — it does not stub or re-implement the lock dance.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

neonConfig.webSocketConstructor = ws;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MUST match the constant in server/tests/globalSetup.ts. Hardcoded
// (not imported) so a future change to the high half of the lock key
// fails this test loudly instead of being silently mirrored.
const LOCK_KEY_HI = 0x7e57db;

// A test-only lock key, distinct from the suite's main lock (139)
// and from any other test in this file. Chosen as the originating
// task number (142) so future readers can trace it back.
const TEST_LOCK_KEY_LO = 142;

// Speed up the heartbeat so we don't wait ten real seconds per
// assertion. 250ms gives Postgres plenty of headroom while still
// letting the test complete in well under five seconds.
const TEST_HEARTBEAT_MS = 250;

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

describe('globalSetup queued-run wait visibility (regression for Task #140)', () => {
  it('emits Waiting / still waiting / Lock acquired stderr lines under contention', async () => {
    // Step 1: hold the test-controlled advisory lock from a fresh
    // session. The child globalSetup, redirected at this same key
    // by the hook env var, will contend with us (and only with us).
    const lockClient = await probePool.connect();
    let lockHeld = false;
    let child: ChildProcess | null = null;

    try {
      const acquireResult = await lockClient.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [LOCK_KEY_HI, TEST_LOCK_KEY_LO],
      );
      expect(acquireResult.rows[0]?.acquired).toBe(true);
      lockHeld = true;

      // Step 2: spawn the child. We invoke tsx directly via Node so
      // we don't depend on `npx` being on PATH at test time.
      //
      // Env handling: the child's globalSetup has two safety guards
      // that refuse to run if the resolved test URL would equal
      // DATABASE_URL. We satisfy them by stripping DATABASE_URL from
      // the child's env entirely and passing the test URL only as
      // TEST_DATABASE_URL — the child therefore connects to the
      // same test DB but cannot mistake it for a live URL.
      const tsxBin = resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
      const wrapperPath = resolve(__dirname, '_runGlobalSetupChild.ts');

      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.DATABASE_URL;
      childEnv.TEST_DATABASE_URL = TEST_DB_URL;
      childEnv.VITEST_GLOBALSETUP_TESTHOOK_LOCK_KEY_LO = String(TEST_LOCK_KEY_LO);
      childEnv.VITEST_GLOBALSETUP_TESTHOOK_WAIT_HEARTBEAT_MS = String(TEST_HEARTBEAT_MS);

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

      // Step 3a: the child must announce it is waiting on us.
      await waitFor(
        () =>
          /\[globalSetup\] Waiting for another vitest run to release the test-DB lock/.test(
            stderrBuf,
          ),
        20_000,
        'child to emit "Waiting for another vitest run" line',
      );

      // Step 3b: and must emit at least one "still waiting (Ns)" tick.
      await waitFor(
        () => /\[globalSetup\] still waiting \(\d+s\)/.test(stderrBuf),
        20_000,
        'child to emit "still waiting (Ns)…" heartbeat line',
      );

      // Sanity-check we did NOT see the success line yet — if it was
      // already there before we released, the lock dance is broken
      // (the child somehow proceeded while we still held the lock).
      expect(stderrBuf).not.toMatch(/\[globalSetup\] Lock acquired after/);

      // Step 4: release the lock. The child's blocking
      // pg_advisory_lock should return shortly afterwards and the
      // success line should land on stderr.
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
        LOCK_KEY_HI,
        TEST_LOCK_KEY_LO,
      ]);
      lockHeld = false;

      await waitFor(
        () =>
          /\[globalSetup\] Lock acquired after \d+s — proceeding with test run\./.test(
            stderrBuf,
          ),
        20_000,
        'child to emit "Lock acquired after Ns" success line',
      );

      // Step 5: child should run its (no-op, hook-skipped) post-lock
      // path, return its teardown, the wrapper invokes teardown, and
      // the process exits cleanly.
      const exitInfo = await Promise.race([
        exitPromise,
        new Promise<never>((_, rejectTimeout) =>
          setTimeout(
            () => rejectTimeout(new Error('child did not exit within 30s')),
            30_000,
          ),
        ),
      ]);
      expect(exitInfo.signal).toBe(null);
      expect(exitInfo.code).toBe(0);
    } finally {
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
  }, 90_000);
});
