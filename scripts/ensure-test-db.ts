/**
 * Provision the isolated test database used by the vitest suite (Task #106).
 *
 * Why:
 *   The vitest suite under server/tests/ writes to real tables (orders,
 *   users, password_reset_tokens, etc.) and grants real Postgres roles
 *   (mcp_read_only). Pointing those tests at the production DATABASE_URL
 *   risks orphan rows on aborted cleanup and bucket collisions when two
 *   post-merge runs fire concurrently. This script provisions a sibling
 *   database whose name is `<live-db>_test` so the suite can be redirected
 *   into it.
 *
 * Behavior:
 *   - Reads DATABASE_URL (the live application connection string).
 *   - Computes the test DB name by appending `_test` to the existing
 *     pathname segment (e.g. `neondb` -> `neondb_test`).
 *   - Creates the test database if it does not exist. CREATE DATABASE
 *     cannot run inside a transaction, and there is no IF NOT EXISTS,
 *     so we look it up in pg_database first.
 *   - Prints the resolved TEST_DATABASE_URL on stdout (last line) so
 *     callers in shell can `eval $(node ensure-test-db.ts)`-style or
 *     parse it.
 *
 * Idempotency:
 *   Safe to run repeatedly. A second run is a single SELECT round-trip.
 *
 * Connection notes:
 *   We connect via the @neondatabase/serverless Pool already used by
 *   server/db.ts so this works on both Replit's hosted Postgres (which
 *   uses Neon's WS protocol) and standard Postgres deployments.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

function deriveTestDatabaseUrl(liveUrl: string): { url: string; dbName: string } {
  const u = new URL(liveUrl);
  // pathname is `/dbname`. Refuse if it isn't shaped that way — the
  // alternative is silently appending to an empty path and creating a
  // database literally named `_test`.
  const liveDbName = u.pathname.replace(/^\//, '');
  if (!liveDbName) {
    throw new Error(
      'DATABASE_URL has no database name in its path; cannot derive a test database name.',
    );
  }
  if (liveDbName.endsWith('_test')) {
    throw new Error(
      `DATABASE_URL already points at a *_test database (${liveDbName}). ` +
        'Refusing to derive a test DB from an already-test DB — set TEST_DATABASE_URL ' +
        'explicitly if this was intentional.',
    );
  }
  const testDbName = `${liveDbName}_test`;
  u.pathname = `/${testDbName}`;
  return { url: u.toString(), dbName: testDbName };
}

async function main(): Promise<void> {
  const liveUrl = process.env.DATABASE_URL;
  if (!liveUrl) {
    throw new Error('DATABASE_URL is not set.');
  }

  // Allow operator override — useful when the test DB lives on a
  // completely different host (true CI isolation rather than sibling DB).
  let testUrl: string;
  let testDbName: string;
  if (process.env.TEST_DATABASE_URL) {
    testUrl = process.env.TEST_DATABASE_URL;
    if (testUrl === liveUrl) {
      throw new Error(
        'TEST_DATABASE_URL is identical to DATABASE_URL — refusing to provision tests against the live database.',
      );
    }
    try {
      testDbName = new URL(testUrl).pathname.replace(/^\//, '') || '<unknown>';
    } catch {
      testDbName = '<unparseable URL>';
    }
    process.stderr.write(
      `[ensure-test-db] Using operator-provided TEST_DATABASE_URL (db=${testDbName}).\n`,
    );
  } else {
    const derived = deriveTestDatabaseUrl(liveUrl);
    testUrl = derived.url;
    testDbName = derived.dbName;

    // Connect to the live DB just long enough to ask "does this test DB
    // already exist?" and CREATE it if not. We deliberately use the live
    // pool here — CREATE DATABASE has to be issued from a connection
    // that is NOT already connected to the database being created.
    const adminPool = new Pool({ connectionString: liveUrl, connectionTimeoutMillis: 10_000 });
    try {
      const exists = await adminPool.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [testDbName],
      );
      if (!exists.rows[0]?.exists) {
        // Identifier interpolation is safe here because testDbName is
        // derived from the live DB name (which is itself trusted infra
        // config) plus a fixed `_test` suffix. We still defend with a
        // strict regex to make the assumption explicit.
        if (!/^[a-zA-Z0-9_]+$/.test(testDbName)) {
          throw new Error(`Refusing to CREATE DATABASE with non-identifier name: ${testDbName}`);
        }
        await adminPool.query(`CREATE DATABASE "${testDbName}"`);
        process.stderr.write(`[ensure-test-db] Created test database "${testDbName}".\n`);
      } else {
        process.stderr.write(`[ensure-test-db] Test database "${testDbName}" already exists.\n`);
      }
    } finally {
      await adminPool.end();
    }
  }

  // Stdout is the machine-readable channel — emits the resolved
  // TEST_DATABASE_URL on its own line so the shell caller can capture it.
  process.stdout.write(`${testUrl}\n`);
}

main().catch((err) => {
  process.stderr.write(`[ensure-test-db] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
