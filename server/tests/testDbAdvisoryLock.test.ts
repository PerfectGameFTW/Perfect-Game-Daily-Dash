/**
 * Regression coverage for the cross-run serialization lock (Task #139).
 *
 * `server/tests/globalSetup.ts` acquires a Postgres session-scoped
 * advisory lock on the test DB before truncating, and holds it for
 * the entire `vitest run`. Concurrent invocations targeting the same
 * test DB block at their own globalSetup until the holder releases —
 * which is what stops two CI runs (or a developer running `npm test`
 * while CI is mid-flight) from clobbering each other's fixtures.
 *
 * If a future refactor:
 *   - removes the advisory lock,
 *   - changes the lock key (so concurrent runs no longer contend), or
 *   - drops the heartbeat that keeps the lock-holding session alive,
 * then this test will fail because we will be able to acquire the
 * same lock ourselves from a fresh connection while the suite is
 * running.
 *
 * The constants below are intentionally hardcoded (not imported from
 * globalSetup.ts) so a key change there fails this test loudly
 * instead of being silently mirrored. Keep them in sync with
 * globalSetup.ts manually.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

// MUST match the constants in server/tests/globalSetup.ts. See the
// file-level docstring above for why these are duplicated rather
// than imported.
const LOCK_KEY_HI = 0x7e57db;
const LOCK_KEY_LO = 139;

// Build our own pool so we are guaranteed to be on a different
// session than globalSetup's lock-holding connection. Reusing
// `server/db.ts`'s pool would risk picking up a recycled session
// and producing a false positive.
const probePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  max: 1,
});

afterAll(async () => {
  await probePool.end().catch(() => {});
});

describe('cross-run test DB advisory lock (regression for Task #139)', () => {
  it('is held by globalSetup for the entire suite', async () => {
    // pg_try_advisory_lock returns true iff this session was able to
    // acquire the lock. Another session (globalSetup's) is expected
    // to be holding it right now, so the answer must be false.
    const result = await probePool.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_KEY_HI, LOCK_KEY_LO],
    );

    if (result.rows[0]?.locked) {
      // If we somehow acquired it, release immediately so we don't
      // poison the rest of the run, then fail loud.
      await probePool
        .query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_HI, LOCK_KEY_LO])
        .catch(() => {});
    }

    expect(result.rows[0]?.locked).toBe(false);
  });

  it('is visible in pg_locks under the expected key', async () => {
    // Belt-and-suspenders: pg_try_advisory_lock returning false only
    // proves SOME session holds the lock. Pin causality by inspecting
    // pg_locks directly and confirming there is at least one entry
    // with our exact (classid, objid) pair. Postgres splits the two
    // int4 keys we passed into `classid` (high) and `objid` (low) for
    // userland advisory locks (locktype = 'advisory'), so this
    // matches the lock globalSetup acquired and nothing else.
    const result = await probePool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = $1
          AND objid = $2
          AND objsubid = 2`, // 2 = two-int4 key form
      [LOCK_KEY_HI, LOCK_KEY_LO],
    );
    expect(Number(result.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(1);
  });
});
