/**
 * Vitest setup file (Task #106).
 *
 * Wired in via vitest.config.ts -> test.setupFiles. Vitest evaluates
 * this module BEFORE importing any test file, which means the
 * `process.env.DATABASE_URL` rewrite below happens before
 * `server/db.ts` is ever imported (it reads the env var at module
 * load time and never re-reads it). Every consumer downstream
 * therefore connects to the test database, not the live one.
 *
 * This is a hard safety guarantee: rather than silently falling back
 * to the live DB if TEST_DATABASE_URL is unset, we throw. A failed
 * test run is recoverable; a test run that wipes a row in the live
 * `users` table is not.
 *
 * Resolution order for the test database connection string:
 *   1. process.env.TEST_DATABASE_URL (operator override — preferred
 *      when the test DB is on a separate host or cluster).
 *   2. Derived from DATABASE_URL by appending `_test` to its path
 *      segment (e.g. `…/neondb` -> `…/neondb_test`). This is what
 *      scripts/post-merge.sh uses by default; the matching
 *      database is provisioned by scripts/ensure-test-db.ts.
 *
 * Refuses to run if the resolved test URL equals DATABASE_URL.
 */

const liveUrl = process.env.DATABASE_URL;
const explicit = process.env.TEST_DATABASE_URL;

function deriveTestUrl(live: string | undefined): string | undefined {
  if (!live) return undefined;
  try {
    const u = new URL(live);
    const liveDbName = u.pathname.replace(/^\//, '');
    if (!liveDbName) return undefined;
    // Don't re-suffix an already-test DB.
    const testDbName = liveDbName.endsWith('_test') ? liveDbName : `${liveDbName}_test`;
    u.pathname = `/${testDbName}`;
    return u.toString();
  } catch {
    return undefined;
  }
}

const testUrl = explicit ?? deriveTestUrl(liveUrl);

if (!testUrl) {
  throw new Error(
    'Test setup refused to start: TEST_DATABASE_URL is not set and a test ' +
      'database name could not be derived from DATABASE_URL. The vitest suite ' +
      'must run against an isolated database (Task #106). ' +
      'Either export TEST_DATABASE_URL=<connection string for an isolated DB>, ' +
      'or run scripts/ensure-test-db.ts to provision a sibling `<live>_test` database.',
  );
}

if (liveUrl && testUrl === liveUrl) {
  throw new Error(
    'Test setup refused to start: TEST_DATABASE_URL resolves to the same ' +
      'connection string as DATABASE_URL. Refusing to run automated tests ' +
      'against the live application database.',
  );
}

// Override BEFORE any test-file import chain reaches server/db.ts.
process.env.DATABASE_URL = testUrl;
