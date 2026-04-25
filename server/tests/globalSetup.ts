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
const LOCK_KEY_LO = 139;

/**
 * Maximum time we will wait to acquire the lock before giving up. Set
 * via `lock_timeout` so the wait surfaces a clear Postgres error
 * ("canceling statement due to lock timeout") rather than hanging the
 * post-merge hook indefinitely behind a stuck previous run. Fifteen
 * minutes is well past the longest plausible vitest run on this repo
 * but short enough that an actually-stuck previous run gets noticed
 * the same business day.
 */
const LOCK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

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
    // `lock_timeout` is session-scoped on this connection, so it bounds
    // ONLY the wait below — not anything the application code under
    // test does later. Concurrent runs see a clear Postgres error
    // ("canceling statement due to lock timeout") if a previous run is
    // genuinely stuck, instead of a silent hang.
    await lockClient.query(`SET lock_timeout = ${LOCK_WAIT_TIMEOUT_MS}`);
    await lockClient.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_HI, LOCK_KEY_LO]);
    // Reset the timeout so the heartbeat / truncate aren't affected.
    await lockClient.query('SET lock_timeout = 0');

    // Truncate the schema — same logic as before, but now safely
    // serialized behind the advisory lock so a concurrent run cannot
    // wipe our fixtures partway through.
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
