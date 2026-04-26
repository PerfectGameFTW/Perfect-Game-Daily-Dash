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

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db } from '../db';
import { syncAudit, syncDailyBudget } from '@shared/schema';
import {
  tryAcquireSyncLock,
  consumeDailyBudget,
  withDailyBudget,
  MAX_SQUARE_PAGES_PER_DAY,
} from '../services/syncLocks';
import { syncService } from '../services/syncService';
import { logger } from '../logger';

// Synthetic day key used for budget tests. Must NOT start with '9999-'
// because syncDailyBudgetTrim.test.ts uses '9999-' as its cleanup
// prefix and would delete this row when both suites run in parallel.
// The implementation under test treats `day` as an opaque text key,
// so any unique string works — '8888-12-31' is reserved for this file.
const SYNTHETIC_TEST_DAY = '8888-12-31';

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

    it('emits a single canonical sync.dailyBudget.rejected warning whenever it returns ok:false (Task #163)', async () => {
      // Operators need ONE grep target ("sync.dailyBudget.rejected")
      // for "we hit the daily Square page cap" no matter which caller
      // tripped it — including future callers and the abusive
      // crash-loop scenario from Task #120 where caller-side logging
      // can't be trusted. Pinning the log line down here means a
      // future refactor that deletes / renames / silences it fails
      // this test instead of failing silently in production.

      const day = testDay();
      // Two seeded denial scenarios so we exercise both ok:false code
      // paths in `consumeDailyBudget`:
      //   (a) UPDATE returns zero rows because the WHERE-guard short-
      //       circuits when used + pages > cap (the "would exceed"
      //       path — most common in production).
      //   (b) Same code path entered with the day already AT the cap
      //       (the "already exhausted" follow-up path that a long-
      //       running backfill hits on every subsequent page).
      // Both must produce the same canonical log line so any caller
      // grepping for it sees both kinds of rejection.
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: MAX_SQUARE_PAGES_PER_DAY - 1,
      });

      const warnSpy = vi.spyOn(logger, 'warn');
      try {
        // (a) Would-exceed: request 2 pages with 1 slot remaining.
        const r1 = await consumeDailyBudget(2, day);
        expect(r1.ok).toBe(false);

        // (b) Already-at-cap: bring the row to the cap, then ask for
        //     one more page.
        await db
          .update(syncDailyBudget)
          .set({ pagesUsed: MAX_SQUARE_PAGES_PER_DAY })
          .where(eq(syncDailyBudget.day, day));
        const r2 = await consumeDailyBudget(1, day);
        expect(r2.ok).toBe(false);

        // Filter the spy to only our key so an unrelated warning from
        // another part of the system doesn't flake the assertion.
        // Cleared, well-formed contract: one line per rejection,
        // carrying the requested page count, current pages_used, and
        // the cap (per Task #163's "Done looks like").
        const calls = warnSpy.mock.calls.filter(
          (c) => c[0] === 'sync.dailyBudget.rejected',
        );
        expect(calls).toHaveLength(2);

        const [, ctxA] = calls[0];
        expect(ctxA).toMatchObject({
          pageCount: 2,
          pagesUsed: MAX_SQUARE_PAGES_PER_DAY - 1,
          cap: MAX_SQUARE_PAGES_PER_DAY,
          dateStr: day,
        });

        const [, ctxB] = calls[1];
        expect(ctxB).toMatchObject({
          pageCount: 1,
          pagesUsed: MAX_SQUARE_PAGES_PER_DAY,
          cap: MAX_SQUARE_PAGES_PER_DAY,
          dateStr: day,
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does NOT emit sync.dailyBudget.rejected when the request is granted (Task #163)', async () => {
      // The companion guard: a successful consume must NOT produce a
      // rejection log line. Otherwise operators paging on this key
      // would get woken up for normal traffic.
      const day = testDay();
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: 0,
      });

      const warnSpy = vi.spyOn(logger, 'warn');
      try {
        const result = await consumeDailyBudget(3, day);
        expect(result.ok).toBe(true);

        const calls = warnSpy.mock.calls.filter(
          (c) => c[0] === 'sync.dailyBudget.rejected',
        );
        expect(calls).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
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

  // No-refund-on-failure contract (Task #120). The production loops
  // (e.g. `syncGiftCardsHistoricalBackfill` in `server/services/
  // syncService.ts`) call `consumeDailyBudget(1)` BEFORE issuing a
  // Square API request, then process the page. If the per-page work
  // throws after the consume — Square API error, DB hiccup, anything
  // — the consumed budget stays consumed. The contract is deliberate:
  // Square has already been called (or attempted), and a "refund on
  // failure" semantics would let a hostile / buggy retry loop crash
  // partway through page processing many times in a row, exhausting
  // the daily cap many multiples over while appearing never to spend
  // it. These tests pin that invariant down so a future "helpful"
  // rollback refactor of `consumeDailyBudget` cannot quietly weaken
  // the abuse guarantee from Task #86.
  describe('no-refund-on-failure contract (Task #120)', () => {
    it('a synthetic mid-page failure after consumeDailyBudget leaves the counter advanced', async () => {
      const day = testDay();
      // Mirror the production sequence: row exists at 5 pages used,
      // a sync loop reserves 3 more, then a Square fetch throws
      // before any "rollback" path could plausibly run.
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: 5,
      });

      // The `try` block emulates one iteration of the production
      // backfill loop. The `expect.rejects` wrapper proves the
      // failure surfaces — important so a future refactor can't
      // silently swallow the throw and make this test vacuous.
      await expect(
        (async () => {
          const grant = await consumeDailyBudget(3, day);
          expect(grant.ok).toBe(true);
          expect(grant.used).toBe(8);
          // Synthetic stand-in for a Square 5xx / network blip
          // happening AFTER the budget reservation but BEFORE
          // pages are actually processed. The whole point of the
          // contract is that this is the worst case to defend
          // against — the retrying caller looks legitimate but
          // would otherwise re-spend budget on every crash.
          throw new Error('synthetic mid-page fetch failure');
        })(),
      ).rejects.toThrow(/synthetic mid-page fetch failure/);

      // Counter MUST still be at 5 + 3 = 8. If a future refactor
      // adds a try/catch in consumeDailyBudget that decrements on
      // error, or wraps the whole thing in a transaction that
      // rolls back, this assertion fails immediately.
      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(8);
    });

    it('repeated consume-then-throw cycles accumulate spend so a crash-loop cannot reset the cap', async () => {
      // The abuse scenario the contract exists to defend against:
      // an attacker (or a buggy retry handler) triggers many
      // backfill attempts that each consume 1 page and then crash.
      // If consumed budget were refunded on failure, the cap would
      // never advance and the attacker could call Square forever.
      // Pin down that EVERY consume sticks, even when the caller
      // throws on every iteration.
      const day = testDay();
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: 0,
      });

      const ATTEMPTS = 5;
      for (let i = 0; i < ATTEMPTS; i++) {
        await expect(
          (async () => {
            const grant = await consumeDailyBudget(1, day);
            expect(grant.ok).toBe(true);
            // Caller does some work, then dies. Production
            // analogues include `throw fetchErr` after
            // `logIfSquare429(...)` in the historical gift-card
            // loop and any uncaught DB error inside the per-page
            // body of the orders/payments backfill.
            throw new Error(`crash on iteration ${i}`);
          })(),
        ).rejects.toThrow(/crash on iteration/);
      }

      // After ATTEMPTS crash-loops, the counter must reflect every
      // consume — proving the cap moves toward exhaustion exactly
      // as fast as the underlying Square traffic does, regardless
      // of whether the caller succeeds or fails on each page.
      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(ATTEMPTS);
    });

    it('withDailyBudget preserves the no-refund-on-failure contract end-to-end (Task #164)', async () => {
      // The whole point of `withDailyBudget` is that callers who
      // wrap their work with it get the Task #120 abuse guarantee
      // by construction — they cannot accidentally invert "fetch
      // then consume" or sneak in a refund-on-error try/catch.
      // This test pins down all four legs of that contract:
      //
      //   (1) consume happens BEFORE the callback runs;
      //   (2) callback never runs when the cap is already exhausted
      //       (so Square is not called when budget is denied);
      //   (3) an error thrown from the callback propagates UNCHANGED;
      //   (4) the consumed budget STAYS consumed even when the
      //       callback throws — no refund.
      //
      // A future refactor that wraps the callback in a try/catch and
      // decrements the counter on error would fail this test on
      // step (4); a refactor that swaps the consume/work order would
      // fail step (1) (callbackRanBeforeConsumeReturned would be
      // observable via a too-low `pagesUsedAtCallbackEntry`).

      const day = testDay();
      // Seed the day at 0 so we can observe the consume-then-throw
      // pattern moving the counter exactly +3 per attempt.
      await db.insert(syncDailyBudget).values({ day, pagesUsed: 0 });

      // (1) + (3) + (4): callback throws, counter MUST advance.
      let callbackEntered = false;
      let pagesUsedAtCallbackEntry = -1;
      const sentinelErr = new Error('synthetic mid-callback Square failure');
      await expect(
        withDailyBudget(
          3,
          async () => {
            callbackEntered = true;
            // Read the persisted counter at the exact moment the
            // callback runs. If consume hadn't happened yet this
            // would be 0; the contract guarantees it's already 3.
            const inFlight = await db
              .select()
              .from(syncDailyBudget)
              .where(eq(syncDailyBudget.day, day))
              .limit(1);
            pagesUsedAtCallbackEntry = inFlight[0]?.pagesUsed ?? -1;
            throw sentinelErr;
          },
          day,
        ),
      ).rejects.toBe(sentinelErr); // rethrown unchanged — same identity

      expect(callbackEntered).toBe(true);
      // Step (1): consume ran first. If the helper ever inverts this,
      // pagesUsedAtCallbackEntry would be 0 instead of 3.
      expect(pagesUsedAtCallbackEntry).toBe(3);

      // Step (4): the throw did NOT refund.
      const after1 = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(after1[0]?.pagesUsed).toBe(3);

      // (2): when the day is already at the cap, the callback must
      // not run at all — Square would otherwise be called for a
      // page we've already paid for elsewhere.
      await db
        .update(syncDailyBudget)
        .set({ pagesUsed: MAX_SQUARE_PAGES_PER_DAY })
        .where(eq(syncDailyBudget.day, day));

      let callbackRanAfterDenial = false;
      const denied = await withDailyBudget(
        1,
        async () => {
          callbackRanAfterDenial = true;
          return 'should-never-be-returned';
        },
        day,
      );
      expect(denied.ok).toBe(false);
      // Even though the helper denies, callback MUST NOT have run.
      expect(callbackRanAfterDenial).toBe(false);
      // Counter is unchanged by the denial path (already at cap; the
      // conditional UPDATE rejected, no debit applied).
      const after2 = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(after2[0]?.pagesUsed).toBe(MAX_SQUARE_PAGES_PER_DAY);
    });

    it('withDailyBudget returns the callback result on success (Task #164)', async () => {
      // Companion happy-path test so a refactor that, say, always
      // returns `ok: false` would fail loudly here even if the
      // throw-path test above somehow still passed.
      const day = testDay();
      await db.insert(syncDailyBudget).values({ day, pagesUsed: 0 });

      const result = await withDailyBudget(
        2,
        async () => ({ payload: 'ok', items: [1, 2, 3] }),
        day,
      );

      expect(result.ok).toBe(true);
      // Discriminated union: TS narrows .result only on the ok:true
      // branch. Asserting .ok above proves the narrowing target.
      if (result.ok) {
        expect(result.result).toEqual({ payload: 'ok', items: [1, 2, 3] });
        expect(result.used).toBe(2);
        expect(result.cap).toBe(MAX_SQUARE_PAGES_PER_DAY);
      }

      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(2);
    });

    it('a denial (ok:false) followed by a thrown error still leaves the counter unchanged', async () => {
      // Companion to the above: a request that's REJECTED at the
      // cap MUST NOT be charged even if the caller subsequently
      // throws while handling the rejection. The denial path was
      // already covered by the cap-rejection test, but pairing it
      // with a post-rejection throw guards against a future
      // refactor that uses a single try/finally to "best effort"
      // commit budget regardless of the SQL outcome.
      const day = testDay();
      await db.insert(syncDailyBudget).values({
        day,
        pagesUsed: MAX_SQUARE_PAGES_PER_DAY,
      });

      await expect(
        (async () => {
          const grant = await consumeDailyBudget(1, day);
          expect(grant.ok).toBe(false);
          expect(grant.used).toBe(MAX_SQUARE_PAGES_PER_DAY);
          throw new Error('synthetic post-rejection failure');
        })(),
      ).rejects.toThrow(/synthetic post-rejection failure/);

      const stored = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, day))
        .limit(1);
      expect(stored[0]?.pagesUsed).toBe(MAX_SQUARE_PAGES_PER_DAY);
    });
  });
});
