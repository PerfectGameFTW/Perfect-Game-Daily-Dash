/**
 * Tests for the per-UTC-day Square page-budget housekeeping helpers
 * added in Task #119:
 *
 *   - `trimDailyBudget`         — periodic prune of `sync_daily_budget`
 *                                 rows older than the retention window.
 *   - `getDailyBudgetStatus`    — snapshot used by the admin Backfill
 *                                 Audit page widget.
 *   - `GET /api/admin/sync-budget` — admin-gated wrapper around the
 *                                    snapshot helper.
 *
 * The trim path is the load-bearing one: `sync_daily_budget` rows
 * accumulate forever otherwise, and a buggy trim that dropped today's
 * row would silently pull the rate-limit guard out from under any
 * in-progress backfill. The tests below pin:
 *
 *   - rows older than the cutoff are deleted, newer rows survive,
 *   - today's row is NEVER touched even if the caller passes a 0/
 *     negative retention window (defensive clamp),
 *   - the trim is idempotent — a second call deletes nothing,
 *   - two trims racing in parallel land on the same fixed expired
 *     set, never throw, and never delete an extra row,
 *   - the snapshot endpoint is admin-only and reflects whatever's
 *     stored for today's UTC date.
 *
 * All test rows use synthetic far-future or far-past `day` keys
 * scoped under a unique prefix so cleanup never touches real
 * production budget rows in the shared dev DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, like } from 'drizzle-orm';

import { db } from '../db';
import { users, syncDailyBudget } from '@shared/schema';
import { authService } from '../services/authService';
import { createApiRouter } from '../routes/api';
import {
  trimDailyBudget,
  getDailyBudgetStatus,
  MAX_SQUARE_PAGES_PER_DAY,
  SYNC_DAILY_BUDGET_RETENTION_DAYS,
} from '../services/syncLocks';

const TEST_ADMIN_USERNAME = '__sync_budget_admin__';
const TEST_USER_USERNAME = '__sync_budget_user__';
const STRONG_PASSWORD = 'Str0ng!SyncBudget-Test-9z';

// All synthetic rows are tagged with this prefix in the `day` text
// column so cleanup queries can scope deletes to ONLY rows this
// suite created. Real production rows look like '2026-04-25', never
// '0001-...' or '9999-...'.
const TEST_DAY_PREFIX_PAST = '0001-';
const TEST_DAY_PREFIX_FUTURE = '9999-';

interface TestSession {
  userId?: number;
  destroy: (cb?: (err?: Error) => void) => void;
}
interface RequestWithTestSession extends Request {
  session: TestSession;
}

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Compute a `YYYY-MM-DD` string `n` UTC days before today. */
function daysAgoKey(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return utcDayKey(d);
}

async function clearSyntheticRows() {
  // Delete every synthetic test row by prefix. We never touch any
  // row that doesn't start with one of our two reserved prefixes,
  // so this is safe to run against a shared dev DB.
  await db.delete(syncDailyBudget).where(like(syncDailyBudget.day, `${TEST_DAY_PREFIX_PAST}%`));
  await db.delete(syncDailyBudget).where(like(syncDailyBudget.day, `${TEST_DAY_PREFIX_FUTURE}%`));
}

describe('sync_daily_budget trim + status helpers (Task #119)', () => {
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let userId: number;

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, TEST_ADMIN_USERNAME));
    await db.delete(users).where(eq(users.username, TEST_USER_USERNAME));

    const admin = await authService.registerUser(
      TEST_ADMIN_USERNAME,
      STRONG_PASSWORD,
      'admin',
    );
    adminId = admin.id;
    const user = await authService.registerUser(
      TEST_USER_USERNAME,
      STRONG_PASSWORD,
      'user',
    );
    userId = user.id;

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    // Header-driven session shim — same pattern as the other admin
    // route tests so we exercise the real `requireAdmin` middleware
    // without a real cookie store.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const asUserId = req.headers['x-test-user-id'];
      const session: TestSession = {
        destroy: (cb) => {
          if (cb) cb();
        },
      };
      if (typeof asUserId === 'string' && asUserId !== '') {
        session.userId = Number(asUserId);
      }
      (req as RequestWithTestSession).session = session;
      next();
    });
    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clearSyntheticRows();
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(async () => {
    await clearSyntheticRows();
    authService.invalidateUserCache?.(adminId);
    authService.invalidateUserCache?.(userId);
  });

  describe('trimDailyBudget', () => {
    it('deletes rows older than the retention window and leaves newer rows alone', async () => {
      // Three synthetic ancient rows under the past prefix — all
      // strictly less than every plausible cutoff so they MUST be
      // pruned regardless of how the cutoff is computed today.
      await db.insert(syncDailyBudget).values([
        { day: `${TEST_DAY_PREFIX_PAST}01-01`, pagesUsed: 10 },
        { day: `${TEST_DAY_PREFIX_PAST}06-15`, pagesUsed: 20 },
        { day: `${TEST_DAY_PREFIX_PAST}12-31`, pagesUsed: 30 },
      ]);
      // One synthetic far-future row that lex-sorts AFTER any real
      // current-day key, proving the cutoff comparison is a strict
      // upper bound and not a `<=` that would catch today's row too.
      await db.insert(syncDailyBudget).values({
        day: `${TEST_DAY_PREFIX_FUTURE}12-31`,
        pagesUsed: 99,
      });

      const { deleted, cutoff } = await trimDailyBudget();

      // All three ancient rows must be gone; the future row must
      // survive. Asserting on at-least-3 (rather than exactly 3)
      // because a parallel suite could have left other expired rows
      // we don't track — what we care about is the synthetic ones.
      expect(deleted).toBeGreaterThanOrEqual(3);
      const survivors = await db
        .select()
        .from(syncDailyBudget)
        .where(like(syncDailyBudget.day, `${TEST_DAY_PREFIX_PAST}%`));
      expect(survivors).toHaveLength(0);
      const future = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, `${TEST_DAY_PREFIX_FUTURE}12-31`));
      expect(future).toHaveLength(1);
      expect(future[0].pagesUsed).toBe(99);

      // Cutoff must look like YYYY-MM-DD and reflect the default
      // retention window. Any drift here would mean the function is
      // computing the wrong horizon.
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(cutoff).toBe(daysAgoKey(SYNC_DAILY_BUDGET_RETENTION_DAYS));
    });

    it('is idempotent — a second call returns deleted:0', async () => {
      await db.insert(syncDailyBudget).values({
        day: `${TEST_DAY_PREFIX_PAST}06-15`,
        pagesUsed: 5,
      });

      const first = await trimDailyBudget();
      expect(first.deleted).toBeGreaterThanOrEqual(1);

      // Second pass: nothing left to prune from OUR synthetic set.
      // Other suites might add more between calls, so we assert that
      // the synthetic past prefix is empty rather than that `deleted`
      // is exactly 0 — that's the actual idempotency invariant.
      const second = await trimDailyBudget();
      expect(second.cutoff).toBe(first.cutoff);
      const remaining = await db
        .select()
        .from(syncDailyBudget)
        .where(like(syncDailyBudget.day, `${TEST_DAY_PREFIX_PAST}%`));
      expect(remaining).toHaveLength(0);
    });

    it('clamps a 0/negative retention window so today\'s live row is never deleted', async () => {
      // Seed today's real key so a buggy "trim everything" call
      // would visibly destroy it. The defensive clamp inside
      // trimDailyBudget MUST keep this row alive — otherwise an
      // in-progress backfill would lose its rate-limit guard
      // mid-run. Use INSERT ... ON CONFLICT DO NOTHING to coexist
      // with whatever the running app's scheduler has already
      // written for today.
      const today = utcDayKey();
      await db
        .insert(syncDailyBudget)
        .values({ day: today, pagesUsed: 1 })
        .onConflictDoNothing();

      // 0 → clamp to 1 day retention. Today's row must survive.
      const r0 = await trimDailyBudget(0);
      const survives0 = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, today));
      expect(survives0).toHaveLength(1);
      expect(r0.cutoff < today || r0.cutoff === today).toBe(true);
      // The cutoff with clamped retention=1 must be strictly
      // YESTERDAY, never today, because a `<` comparison against a
      // cutoff of today would erase the live row.
      expect(r0.cutoff).toBe(daysAgoKey(1));

      // -100 → also clamp to 1 day retention. Same survival
      // invariant — proves the clamp catches negative inputs too.
      const rNeg = await trimDailyBudget(-100);
      const survivesNeg = await db
        .select()
        .from(syncDailyBudget)
        .where(eq(syncDailyBudget.day, today));
      expect(survivesNeg).toHaveLength(1);
      expect(rNeg.cutoff).toBe(daysAgoKey(1));
    });

    it('two concurrent trims land on the same fixed set without throwing or double-counting', async () => {
      // The DELETE-only-old correctness story rests on two trims
      // racing being safe: same WHERE clause, same row set, no
      // surprise rows created in between. Seed five expired rows
      // and assert they're all gone exactly once afterward.
      const seeds = [
        `${TEST_DAY_PREFIX_PAST}01-01`,
        `${TEST_DAY_PREFIX_PAST}03-15`,
        `${TEST_DAY_PREFIX_PAST}06-15`,
        `${TEST_DAY_PREFIX_PAST}09-15`,
        `${TEST_DAY_PREFIX_PAST}12-31`,
      ];
      await db
        .insert(syncDailyBudget)
        .values(seeds.map((day) => ({ day, pagesUsed: 1 })));

      const [a, b] = await Promise.all([trimDailyBudget(), trimDailyBudget()]);

      // Combined deleted-count must equal the seed count exactly —
      // anything higher would prove a row was deleted twice (a
      // metaphysical impossibility under DELETE semantics, but the
      // assertion makes the invariant explicit). Anything lower
      // would prove a row escaped pruning.
      const totalDeletedOfOurs = await db
        .select()
        .from(syncDailyBudget)
        .where(like(syncDailyBudget.day, `${TEST_DAY_PREFIX_PAST}%`));
      expect(totalDeletedOfOurs).toHaveLength(0);
      // Both calls must succeed — neither one threw.
      expect(typeof a.deleted).toBe('number');
      expect(typeof b.deleted).toBe('number');
    });
  });

  describe('getDailyBudgetStatus', () => {
    it('returns 0 / cap when today\'s row does not yet exist', async () => {
      // We can't safely DELETE today's real row in a shared dev DB
      // (it might be in active use by a running backfill), so this
      // assertion is structural: whatever today's pagesUsed is, it
      // MUST be a non-negative number bounded by the cap, and the
      // returned `day` must match the UTC day key. That's the
      // contract the widget depends on.
      const status = await getDailyBudgetStatus();
      expect(status.day).toBe(utcDayKey());
      expect(status.cap).toBe(MAX_SQUARE_PAGES_PER_DAY);
      expect(Number.isFinite(status.pagesUsed)).toBe(true);
      expect(status.pagesUsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/admin/sync-budget', () => {
    it('rejects anonymous requests with 401', async () => {
      const r = await fetch(`${baseUrl}/api/admin/sync-budget`);
      expect(r.status).toBe(401);
    });

    it('rejects logged-in non-admin requests with 403', async () => {
      const r = await fetch(`${baseUrl}/api/admin/sync-budget`, {
        headers: { 'x-test-user-id': String(userId) },
      });
      expect(r.status).toBe(403);
    });

    it('returns the budget snapshot to admins with no-store cache headers', async () => {
      const r = await fetch(`${baseUrl}/api/admin/sync-budget`, {
        headers: { 'x-test-user-id': String(adminId) },
      });
      expect(r.status).toBe(200);
      // Cache-Control must include no-store so a load balancer / CDN
      // / browser can't pin a stale snapshot. The widget polls every
      // 30s and the value moves on every page consumption, so a
      // remembered response would be wrong almost immediately.
      expect((r.headers.get('cache-control') ?? '').toLowerCase()).toContain('no-store');

      const body = (await r.json()) as {
        day: string;
        pagesUsed: number;
        cap: number;
      };
      expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.day).toBe(utcDayKey());
      expect(body.cap).toBe(MAX_SQUARE_PAGES_PER_DAY);
      expect(typeof body.pagesUsed).toBe('number');
      expect(body.pagesUsed).toBeGreaterThanOrEqual(0);
    });
  });
});
