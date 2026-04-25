/**
 * Vitest globalSetup (Task #136).
 *
 * Runs ONCE per `vitest run` invocation, before any worker is spawned
 * and therefore before any test file or `setupFiles` entry is loaded.
 * Its single job: leave the test database in a hermetic, empty state.
 *
 * Background:
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
 *   we no-op — the suite will fail loudly later when a test tries to
 *   query a missing table, which is the correct signal that
 *   `npm run db:push` against the test DB has not been run yet.
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

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

export default async function globalSetup(): Promise<void> {
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

  const pool = new Pool({ connectionString: testUrl, connectionTimeoutMillis: 10_000 });
  try {
    // Enumerate every base table in the `public` schema. pg_tables
    // already excludes views, materialized views, system catalogs, and
    // anything in non-public schemas, so this gives us exactly the set
    // of business tables drizzle pushed.
    const result = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tables = result.rows.map((r) => r.tablename);
    if (tables.length === 0) {
      // No schema in the test DB yet — let the individual tests fail
      // loudly so the operator knows to run `npm run db:push` against
      // the test target. Silently no-op'ing here is the right call:
      // attempting to TRUNCATE an empty list is a syntax error in
      // Postgres, and we don't want to invent a different error for
      // "your test DB has no tables".
      return;
    }

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
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}
