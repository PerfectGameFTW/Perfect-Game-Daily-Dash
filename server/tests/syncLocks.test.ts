/**
 * Tests for the two hard guarantees protecting Square's shared API
 * budget from a runaway / hostile backfill (Task #86):
 *
 *  1. The Postgres advisory lock acquired by every historical /
 *     backfill flow — proven by holding it manually and asserting
 *     `startHistoricalOrdersPaymentsBackfill` short-circuits with
 *     `alreadyRunning: true` instead of starting a parallel run.
 *
 *  2. The per-UTC-day Square page-fetch budget — proven by seeding
 *     the day's row close to the cap and asserting that the next
 *     `consumeDailyBudget` call returns `ok: false` and leaves the
 *     stored counter unchanged so a refactor can't silently
 *     sneak past the cap.
 *
 * These tests touch the real DB (same pattern as
 * passwordReset.test.ts) so they exercise the actual SQL the
 * production service will run, not a mock.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db } from '../db';
import { syncAudit, syncDailyBudget } from '@shared/schema';
import {
  tryAcquireSyncLock,
  consumeDailyBudget,
  MAX_SQUARE_PAGES_PER_DAY,
} from '../services/syncLocks';
import { syncService } from '../services/syncService';

// Synthetic day key used for budget tests. Using a fake far-future
// date keeps the test from ever colliding with the real current-day
// budget row in the shared dev DB, addressing the architect's note
// about test isolation. The implementation under test treats `day`
// as an opaque text key, so any unique string works.
const SYNTHETIC_TEST_DAY = '9999-12-31';

function testDay(): string {
  return SYNTHETIC_TEST_DAY;
}

// All test traffic uses RFC5737 TEST-NET-3 addresses (203.0.113.0/24)
// so cleanup can target only rows we created and never touch real
// operator-triggered audit history.
const TEST_ACTOR_IP_PREFIX = '203.0.113.';

async function clearTestBudget() {
  // Only touches the synthetic test day — never the real current-day
  // row, even when the suite runs against a shared dev DB.
  await db.delete(syncDailyBudget).where(eq(syncDailyBudget.day, testDay()));
}

async function clearTestAuditRows() {
  // Scope deletes to rows tagged with our test actor-IP prefix so we
  // never wipe real backfill rejection history that the new admin
  // Backfill Audit page surfaces (Task #84).
  await db.execute(sql`
    DELETE FROM sync_audit
    WHERE sync_type = 'orders_payments_backfill'
      AND actor_ip LIKE ${`${TEST_ACTOR_IP_PREFIX}%`}
  `);
}

describe('syncLocks — abuse-resistance guarantees (Task #86)', () => {
  beforeEach(async () => {
    await clearTestBudget();
    await clearTestAuditRows();
  });

  afterAll(async () => {
    await clearTestBudget();
    await clearTestAuditRows();
  });

  describe('historical-backfill advisory lock', () => {
    it(
      'a second startHistoricalOrdersPaymentsBackfill call returns alreadyRunning when the lock is already held',
      async () => {
        // Acquire the shared historical-backfill lock from this test
        // session. Because it's a Postgres *session-scoped* advisory
        // lock, any other session — including the one
        // startHistoricalOrdersPaymentsBackfill opens — will see it
        // as taken until we release it.
        const heldLock = await tryAcquireSyncLock('orders_payments_backfill');
        expect(heldLock).not.toBeNull();

        try {
          const start = new Date('2024-01-01T00:00:00.000Z');
          const end = new Date('2024-01-08T00:00:00.000Z');

          const result = await syncService.startHistoricalOrdersPaymentsBackfill(
            start,
            end,
            7,
            { actorUserId: null, actorIp: '203.0.113.7' },
          );

          expect(result.alreadyRunning).toBe(true);
          expect(result.message).toMatch(/already running/i);

          // The rejection must be audited so repeated/abusive
          // attempts are visible to operators (this is what powers
          // the new admin Backfill Audit page). Filter all the way
          // down to the exact row we expect and order deterministically
          // so the assertion can't be flaked by a parallel run.
          const auditRows = await db.execute(sql`
            SELECT actor_ip, status, result
            FROM sync_audit
            WHERE sync_type = 'orders_payments_backfill'
              AND status = 'rejected'
              AND actor_ip = '203.0.113.7'
              AND result ->> 'reason' = 'already_running'
            ORDER BY started_at DESC
            LIMIT 1
          `);
          const rows = (auditRows.rows ?? auditRows) as Array<{
            actor_ip: string;
            status: string;
            result: { reason?: string } | null;
          }>;
          expect(rows).toHaveLength(1);
          expect(rows[0].status).toBe('rejected');
          expect(rows[0].result?.reason).toBe('already_running');
        } finally {
          await heldLock?.release();
        }
      },
      20_000,
    );

    it('the lock is releasable so subsequent acquirers can take it', async () => {
      // Regression guard: if a future refactor breaks the release
      // path, the suite would otherwise pass on first run and fail
      // mysteriously on the second. Acquire-release-reacquire proves
      // the lock is properly returned to the pool.
      const first = await tryAcquireSyncLock('orders_payments_backfill');
      expect(first).not.toBeNull();
      await first!.release();

      const second = await tryAcquireSyncLock('orders_payments_backfill');
      expect(second).not.toBeNull();
      await second!.release();
    });
  });

  describe('per-UTC-day Square page budget', () => {
    it('returns ok:false and leaves the counter unchanged when a request would exceed the cap', async () => {
      const day = testDay();
      // Seed the day's budget one page below the cap so a 2-page
      // request must be rejected.
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: MAX_SQUARE_PAGES_PER_DAY - 1,
      });

      const result = await consumeDailyBudget(2, testDay());

      expect(result.ok).toBe(false);
      expect(result.cap).toBe(MAX_SQUARE_PAGES_PER_DAY);
      expect(result.used).toBe(MAX_SQUARE_PAGES_PER_DAY - 1);

      // Critical invariant: a denied request must not partially
      // consume budget. If the conditional-UPDATE guard ever
      // regressed (e.g. someone split it into a SELECT-then-UPDATE),
      // this assertion would fail.
      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(MAX_SQUARE_PAGES_PER_DAY - 1);
    });

    it('grants a request that fits exactly to the cap and rejects the next page', async () => {
      const day = testDay();
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: MAX_SQUARE_PAGES_PER_DAY - 1,
      });

      const allowed = await consumeDailyBudget(1, testDay());
      expect(allowed.ok).toBe(true);
      expect(allowed.used).toBe(MAX_SQUARE_PAGES_PER_DAY);

      const rejected = await consumeDailyBudget(1, testDay());
      expect(rejected.ok).toBe(false);
      expect(rejected.used).toBe(MAX_SQUARE_PAGES_PER_DAY);

      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(MAX_SQUARE_PAGES_PER_DAY);
    });

    it('two concurrent requests racing for the last page slot grant exactly one and leave the counter at the cap', async () => {
      // The real abuse scenario: two backfills hitting
      // consumeDailyBudget at the same moment near the cap. The
      // conditional UPDATE inside consumeDailyBudget must guarantee
      // that exactly one wins — anything else (e.g. a SELECT-then-
      // UPDATE refactor) would let both proceed and silently exceed
      // the cap.
      const day = testDay();
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: MAX_SQUARE_PAGES_PER_DAY - 1,
      });

      const [a, b] = await Promise.all([
        consumeDailyBudget(1, testDay()),
        consumeDailyBudget(1, testDay()),
      ]);

      const wins = [a, b].filter((r) => r.ok);
      const losses = [a, b].filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(wins[0].used).toBe(MAX_SQUARE_PAGES_PER_DAY);

      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(MAX_SQUARE_PAGES_PER_DAY);
    });

    it('creates the day row on first call when none exists', async () => {
      // Day row is cleared in beforeEach; first call should INSERT it
      // and grant the request.
      const result = await consumeDailyBudget(5, testDay());
      expect(result.ok).toBe(true);
      expect(result.used).toBe(5);

      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, testDay()))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(5);
    });
  });
});
