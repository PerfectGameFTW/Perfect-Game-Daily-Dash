/**
 * Vitest globalSetup (Tasks #136 and #139).
 *
 * Runs ONCE per `vitest run` invocation, before any worker is spawned
 * and therefore before any test file or `setupFiles` entry is loaded.
 * Two responsibilities:
 *
 *   1. Serialize concurrent test runs that share the same test
 *      database (Task #139).
 *   2. Leave the test database in a hermetic, empty state (Task #136).
 *
 * Background — why a global truncate exists at all (Task #136):
 *   Task #106 redirected the suite onto a sibling `<live>_test` database
 *   so partial-cleanup leaks no longer threaten production. But the test
 *   DB itself is only re-pushed by scripts/post-merge.sh, and every
 *   aborted vitest run (a thrown assertion before the `finally` block,
 *   a SIGINT during a long fixture, a flaky network) leaves orphan rows
 *   behind. Across many CI invocations those rows accumulate, shadow
 *   freshly-inserted fixtures (unique-key collisions, leftover sessions,
 *   stale tokens), and produce drift bugs that only reproduce on the
 *   N+1th run.
 *
 *   The fix is to truncate every business table once at the top of the
 *   suite. We use TRUNCATE … RESTART IDENTITY CASCADE because:
 *     - RESTART IDENTITY resets the serial sequences so leftover IDs
 *       from a previous run can't shadow autoincrement values used by
 *       the next run (a real source of test-order-dependent failures).
 *     - CASCADE walks foreign keys for us, so we don't have to
 *       topologically sort the schema by hand and re-sort it whenever
 *       the schema changes.
 *
 * Background — why we serialize runs (Task #139):
 *   The truncate above is destructive: it wipes every row in the test
 *   DB. If two `vitest run` invocations target the same Postgres host
 *   (a common case: a developer running `npm test` locally while a
 *   post-merge hook is mid-flight in CI, or two post-merge hooks
 *   firing back-to-back on a busy branch), the second invocation's
 *   globalSetup would TRUNCATE the first invocation's fixtures
 *   partway through its tests, producing impossible-to-debug
 *   "rows that existed a millisecond ago are gone" failures.
 *
 *   The fix is a Postgres session-scoped advisory lock acquired on a
 *   long-lived connection to the test DB. Concurrent invocations
 *   block at globalSetup until the holder's teardown releases the
 *   lock, then proceed in series. The lock key is fixed (so all runs
 *   contend on the same key) but lives in Postgres's userland
 *   advisory-lock namespace — it cannot conflict with any application
 *   query.
 *
 *   We chose serialization over per-run ephemeral databases because:
 *     - It works for ad-hoc `npm test` invocations without requiring
 *       them to provision/drop their own DB on every run (schema
 *       push is the slow part of post-merge.sh).
 *     - The lock is released automatically by Postgres if the test
 *       process is killed mid-run (session ends → lock dropped),
 *       so there is no recovery path to debug after a crash.
 *     - It introduces zero new state for operators to reason about.
 *
 * Background — wait visibility (Task #140):
 *   The serialization above is correct but invisible: a developer who
 *   runs `npm test` while CI's post-merge hook is mid-flight sees no
 *   output for minutes and has no way to tell whether the suite is
 *   stuck, broken, or just queued behind another run. To fix that we
 *   probe the lock first with `pg_try_advisory_lock` (instantly
 *   returns true/false) and only fall back to the blocking
 *   `pg_advisory_lock` when the probe reports contention. When we do
 *   block, we emit a clear stderr message immediately and a
 *   "still waiting (Ns)…" heartbeat every ten seconds, plus a
 *   "Lock acquired after Ns — proceeding" line once the previous run
 *   releases. The uncontended path (the common case) still acquires
 *   in a single round-trip with no extra log noise.
 *
 * Safety:
 *   This file is the most dangerous code in the test suite — it issues
 *   a TRUNCATE against whatever database it connects to. We therefore
 *   duplicate the same two guards from server/tests/setup.ts here
 *   intentionally:
 *     1. Refuse to run if neither TEST_DATABASE_URL is set nor a
 *        `<live>_test` URL can be derived from DATABASE_URL.
 *     2. Refuse to run if the resolved test URL equals DATABASE_URL.
 *   Duplicating the guards (rather than importing setup.ts) means a
 *   future refactor of setup.ts can't accidentally weaken this file's
 *   protection, and vice versa.
 *
 *   The connection itself uses the resolved test URL — never the live
 *   DATABASE_URL — so even if both guards were somehow bypassed, the
 *   only database that could be truncated is the explicitly-selected
 *   test target.
 *
 * Scope:
 *   Only tables in the `public` schema are truncated. Postgres system
 *   catalogs (pg_catalog, information_schema) and any extension/role
 *   metadata live in other schemas and are untouched. The MCP read-only
 *   role itself (created by db.ts on first use) is a role, not a table,
 *   and is also unaffected.
 *
 * Idempotency:
 *   If the test DB has not yet been schema-pushed (zero public tables),
 *   we no-op the truncate — the suite will fail loudly later when a
 *   test tries to query a missing table, which is the correct signal
 *   that `npm run db:push` against the test DB has not been run yet.
 *   The advisory lock is still acquired in that case, so two runs
 *   against an unpushed test DB still serialize correctly.
 */

import { Pool, neonConfig, type PoolClient } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

/**
 * Postgres advisory-lock key (two-int4 form). The values are arbitrary
 * but must be stable across runs so every `vitest run` invocation
 * contends on the same lock. The high half is mnemonic for "TestDB"
 * (0x7E57DB) and the low half is the originating task number (139).
 *
 * Userland advisory locks live in their own namespace and cannot
 * conflict with anything Postgres or the application itself does.
 */
const LOCK_KEY_HI = 0x7e57db; // 8_280_027
const LOCK_KEY_LO_DEFAULT = 139;

/**
 * Test-only hook (Task #142). Set
 * `VITEST_GLOBALSETUP_TESTHOOK_LOCK_KEY_LO` to an integer to override
 * `LOCK_KEY_LO` for a single subprocess invocation. Used by
 * server/tests/globalSetupWaitVisibility.test.ts to spawn a child
 * globalSetup that contends on a *test-controlled* key (so it doesn't
 * deadlock against the suite's own lock or against unrelated runs)
 * and to verify that the two-phase acquisition emits its
 * "Waiting…" / "still waiting (Ns)…" / "Lock acquired after Ns"
 * stderr lines under contention.
 *
 * When this hook is active we ALSO skip the destructive TRUNCATE
 * below: this code path exists purely to exercise the lock dance,
 * not to wipe whichever database happens to be reachable. Coupling
 * the two behaviors behind a single env var keeps the safety
 * property "if you see this hook, no rows were touched" trivially
 * auditable.
 *
 * The hook is a no-op unless the env var is set, so production
 * `vitest run` invocations behave exactly as before.
 */
const LOCK_KEY_LO_OVERRIDE_RAW =
  process.env.VITEST_GLOBALSETUP_TESTHOOK_LOCK_KEY_LO;
const IS_TESTHOOK_ACTIVE = LOCK_KEY_LO_OVERRIDE_RAW !== undefined;
const LOCK_KEY_LO = (() => {
  if (!IS_TESTHOOK_ACTIVE) return LOCK_KEY_LO_DEFAULT;
  const parsed = Number.parseInt(LOCK_KEY_LO_OVERRIDE_RAW!, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `VITEST_GLOBALSETUP_TESTHOOK_LOCK_KEY_LO must be an integer, got: ${LOCK_KEY_LO_OVERRIDE_RAW}`,
    );
  }
  return parsed;
})();

/**
 * Maximum time we will wait to acquire the lock before giving up. Set
 * via `lock_timeout` so the wait surfaces a clear Postgres error
 * ("canceling statement due to lock timeout") rather than hanging the
 * post-merge hook indefinitely behind a stuck previous run. Fifteen
 * minutes is well past the longest plausible vitest run on this repo
 * but short enough that an actually-stuck previous run gets noticed
 * the same business day.
 */
export const LOCK_WAIT_TIMEOUT_MS_DEFAULT = 15 * 60 * 1000;

/**
 * Test-only hook (Task #143). Set
 * `VITEST_GLOBALSETUP_TESTHOOK_LOCK_TIMEOUT_MS` to a positive integer
 * to override `LOCK_WAIT_TIMEOUT_MS` for a single subprocess
 * invocation. Used by server/tests/globalSetupLockTimeout.test.ts to
 * shrink the timeout from 15 minutes to a couple of seconds so the
 * regression test can observe the lock-timeout escape hatch firing
 * without sleeping for the real 15-minute cap. Production
 * `vitest run` invocations are unaffected — the override is only
 * consulted when the env var is set.
 *
 * The override is intentionally wired into the same constant the
 * production `SET lock_timeout = …` query reads from, so a future
 * refactor that drops the SET statement entirely (or pegs the
 * timeout at zero/`-1`/MAX_SAFE_INTEGER) cannot satisfy the
 * regression test by short-circuiting just the override path.
 */
const LOCK_WAIT_TIMEOUT_OVERRIDE_RAW =
  process.env.VITEST_GLOBALSETUP_TESTHOOK_LOCK_TIMEOUT_MS;
const LOCK_WAIT_TIMEOUT_MS = (() => {
  if (LOCK_WAIT_TIMEOUT_OVERRIDE_RAW === undefined)
    return LOCK_WAIT_TIMEOUT_MS_DEFAULT;
  const parsed = Number.parseInt(LOCK_WAIT_TIMEOUT_OVERRIDE_RAW, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `VITEST_GLOBALSETUP_TESTHOOK_LOCK_TIMEOUT_MS must be a positive integer, got: ${LOCK_WAIT_TIMEOUT_OVERRIDE_RAW}`,
    );
  }
  return parsed;
})();

/**
 * Heartbeat interval for the lock-holding connection. Postgres advisory
 * locks are session-scoped: if the connection dies (idle-timeout
 * reaper, network blip, server-side TCP keepalive expiry) the lock is
 * silently released and another concurrent run could then truncate our
 * data mid-suite — exactly the race we are trying to prevent. A cheap
 * `SELECT 1` every 30s keeps the session demonstrably alive on both
 * the client and the server. The heartbeat timer is unref'd so it
 * cannot keep Node alive past the test run.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Stderr "still waiting (Ns)" cadence emitted while a second concurrent
 * `vitest run` is blocked behind the advisory lock (Task #140). Ten
 * seconds is short enough that a developer staring at a frozen-looking
 * terminal sees the next heartbeat well before they reach for ^C, but
 * long enough that a sub-minute wait doesn't drown the test output in
 * a spam of messages. The timer is unref'd so it cannot keep Node
 * alive past the run.
 */
const WAIT_HEARTBEAT_INTERVAL_MS_DEFAULT = 10_000;

/**
 * Test-only hook (Task #142). Set
 * `VITEST_GLOBALSETUP_TESTHOOK_WAIT_HEARTBEAT_MS` to an integer to
 * override `WAIT_HEARTBEAT_INTERVAL_MS` for a single subprocess
 * invocation. The wait-visibility regression test uses this to drop
 * the heartbeat from 10 seconds to a few hundred milliseconds so the
 * test doesn't have to sleep for ten real seconds just to observe a
 * single "still waiting" line. Production runs are unaffected.
 */
const WAIT_HEARTBEAT_OVERRIDE_RAW =
  process.env.VITEST_GLOBALSETUP_TESTHOOK_WAIT_HEARTBEAT_MS;
const WAIT_HEARTBEAT_INTERVAL_MS = (() => {
  if (WAIT_HEARTBEAT_OVERRIDE_RAW === undefined)
    return WAIT_HEARTBEAT_INTERVAL_MS_DEFAULT;
  const parsed = Number.parseInt(WAIT_HEARTBEAT_OVERRIDE_RAW, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `VITEST_GLOBALSETUP_TESTHOOK_WAIT_HEARTBEAT_MS must be a positive integer, got: ${WAIT_HEARTBEAT_OVERRIDE_RAW}`,
    );
  }
  return parsed;
})();

function deriveTestUrl(live: string | undefined): string | undefined {
  if (!live) return undefined;
  try {
    const u = new URL(live);
    const liveDbName = u.pathname.replace(/^\//, '');
    if (!liveDbName) return undefined;
    const testDbName = liveDbName.endsWith('_test') ? liveDbName : `${liveDbName}_test`;
    u.pathname = `/${testDbName}`;
    return u.toString();
  } catch {
    return undefined;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const liveUrl = process.env.DATABASE_URL;
  const explicit = process.env.TEST_DATABASE_URL;
  const testUrl = explicit ?? deriveTestUrl(liveUrl);

  if (!testUrl) {
    throw new Error(
      'globalSetup refused to start: TEST_DATABASE_URL is not set and a test ' +
        'database name could not be derived from DATABASE_URL. The vitest suite ' +
        'must run against an isolated database (Task #106). ' +
        'Either export TEST_DATABASE_URL=<connection string for an isolated DB>, ' +
        'or run scripts/ensure-test-db.ts to provision a sibling `<live>_test` database.',
    );
  }

  if (liveUrl && testUrl === liveUrl) {
    throw new Error(
      'globalSetup refused to truncate: resolved test URL equals DATABASE_URL — ' +
        'refusing to wipe rows from the live application database.',
    );
  }

  // ---------------------------------------------------------------------------
  // Acquire the cross-run advisory lock (Task #139).
  // ---------------------------------------------------------------------------
  // Use a single-connection Pool so we know exactly which session holds
  // the lock; the same client services the truncate and the heartbeat,
  // so the lock cannot be released by a different connection getting
  // recycled out from under us.
  const lockPool = new Pool({
    connectionString: testUrl,
    connectionTimeoutMillis: 10_000,
    max: 1,
  });
  let lockClient: PoolClient;
  try {
    lockClient = await lockPool.connect();
  } catch (err) {
    await lockPool.end().catch(() => {});
    throw err;
  }

  let heartbeat: NodeJS.Timeout | null = null;
  let released = false;

  try {
    // Two-phase acquisition (Task #140). The blocking `pg_advisory_lock`
    // call would silently hang for as long as another `vitest run` holds
    // the lock — a developer running `npm test` while CI's post-merge
    // hook is mid-flight sees no output for minutes and has no way to
    // tell whether the suite is broken, stuck, or just queued. We
    // therefore probe the lock first with `pg_try_advisory_lock`, which
    // returns immediately with a boolean, and only fall back to the
    // blocking variant when it's known-contended. That gives us a place
    // to print a clear "waiting for another vitest run" message — and a
    // periodic "still waiting (Ns)" heartbeat — before the long block
    // begins, so the wait is visible instead of silent.
    const tryResult = await lockClient.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [LOCK_KEY_HI, LOCK_KEY_LO],
    );
    if (!tryResult.rows[0]?.acquired) {
      process.stderr.write(
        '[globalSetup] Waiting for another vitest run to release the test-DB lock (held by another session)…\n',
      );
      const waitStart = Date.now();
      // "still waiting (Ns)" heartbeat. Bounded only by how long
      // `pg_advisory_lock` itself takes to return — clearInterval in
      // the finally below stops it whether the lock was acquired or
      // the lock_timeout fired.
      const waitTicker = setInterval(() => {
        const seconds = Math.round((Date.now() - waitStart) / 1000);
        process.stderr.write(`[globalSetup] still waiting (${seconds}s)…\n`);
      }, WAIT_HEARTBEAT_INTERVAL_MS);
      if (typeof waitTicker.unref === 'function') waitTicker.unref();
      try {
        // `lock_timeout` is session-scoped on this connection, so it
        // bounds ONLY the wait below — not anything the application
        // code under test does later. Concurrent runs see a clear
        // Postgres error ("canceling statement due to lock timeout")
        // if a previous run is genuinely stuck, instead of a silent
        // hang.
        await lockClient.query(`SET lock_timeout = ${LOCK_WAIT_TIMEOUT_MS}`);
        await lockClient.query('SELECT pg_advisory_lock($1, $2)', [
          LOCK_KEY_HI,
          LOCK_KEY_LO,
        ]);
        // Reset the timeout so the heartbeat / truncate aren't affected.
        await lockClient.query('SET lock_timeout = 0');
      } finally {
        clearInterval(waitTicker);
      }
      const waited = Math.round((Date.now() - waitStart) / 1000);
      process.stderr.write(
        `[globalSetup] Lock acquired after ${waited}s — proceeding with test run.\n`,
      );
    }

    // Truncate the schema — same logic as before, but now safely
    // serialized behind the advisory lock so a concurrent run cannot
    // wipe our fixtures partway through.
    //
    // The Task #142 test hook short-circuits the truncate: when the
    // hook is active this invocation exists purely to exercise the
    // lock dance from a subprocess (see the LOCK_KEY_LO_OVERRIDE
    // docstring above), and wiping the test DB out from under a
    // concurrently-running suite would corrupt every other test
    // file's fixtures. Skipping is safe because the hook is only
    // ever set by server/tests/globalSetupWaitVisibility.test.ts.
    if (IS_TESTHOOK_ACTIVE) {
      heartbeat = setInterval(() => {
        lockClient.query('SELECT 1').catch(() => {
          /* see comment on the production heartbeat below */
        });
      }, HEARTBEAT_INTERVAL_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      return async () => {
        if (released) return;
        released = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
            LOCK_KEY_HI,
            LOCK_KEY_LO,
          ]);
        } catch {
          /* connection may already be gone; teardown still completes */
        }
        try {
          lockClient.release();
        } catch {
          /* ignore */
        }
        await lockPool.end().catch(() => {});
      };
    }

    const result = await lockClient.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = result.rows.map((r) => r.tablename);
    if (tables.length > 0) {
      // Quote identifiers so unusual table names (reserved words, mixed
      // case) don't cause a parse error, and schema-qualify with `public`
      // so a non-default search_path can't accidentally redirect the
      // TRUNCATE at a same-named table in another schema. CASCADE handles
      // foreign-key ordering for us; RESTART IDENTITY resets serial
      // sequences so leftover IDs from a previous aborted run can't
      // shadow new ones.
      const quoted = tables
        .map((t) => `"public"."${t.replace(/"/g, '""')}"`)
        .join(', ');
      await lockClient.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    }
    // If tables.length === 0, the test DB has not been schema-pushed
    // yet. Individual tests will fail loudly when they try to query
    // a missing table — that is the correct signal that
    // `npm run db:push` against the test target has not been run.

    // Start the heartbeat AFTER the truncate so we don't issue
    // overlapping queries on the same client during setup.
    heartbeat = setInterval(() => {
      // Fire-and-forget; if the heartbeat fails, the connection is
      // already dying and the lock is effectively gone. There is
      // nothing useful we can do from a setInterval callback — the
      // teardown will surface the underlying error when it tries to
      // release.
      lockClient.query('SELECT 1').catch(() => {
        /* see comment above */
      });
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep Node alive on this timer.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  } catch (err) {
    // Setup failed after we got a client but before we returned the
    // teardown — release everything we acquired so we don't leak a
    // connection or a held lock.
    if (heartbeat) clearInterval(heartbeat);
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
        LOCK_KEY_HI,
        LOCK_KEY_LO,
      ]);
    } catch {
      /* connection may already be unhealthy; ending the pool is enough */
    }
    try {
      lockClient.release();
    } catch {
      /* ignore */
    }
    await lockPool.end().catch(() => {});
    throw err;
  }

  // Vitest will invoke this teardown once after every test file has
  // finished. Until it runs, the lock is held and any concurrent
  // `vitest run` against the same test DB blocks at its own
  // globalSetup.
  return async () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
        LOCK_KEY_HI,
        LOCK_KEY_LO,
      ]);
    } catch {
      // If the connection died, the lock is already released by
      // Postgres. Swallow so teardown still completes cleanly.
    }
    try {
      lockClient.release();
    } catch {
      /* ignore */
    }
    await lockPool.end().catch(() => {});
  };
}
