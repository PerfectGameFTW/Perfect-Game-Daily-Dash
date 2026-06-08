/**
 * DB-level concurrency control and audit/budget bookkeeping for the
 * historical / backfill sync paths.
 *
 * Why this lives outside `syncService.ts`:
 * - The original in-process `alreadyRunning` flag in `syncService` did not
 *   survive process restarts and offered no protection against multiple
 *   server instances racing for the shared Square API. Postgres advisory
 *   locks fix both gaps without requiring a separate lock service.
 * - Each historical/backfill trigger is recorded in `sync_audit` so an
 *   operator can see who started a run and how it ended.
 * - A shared per-UTC-day Square page budget bounds the worst-case impact
 *   of a runaway (or maliciously triggered) backfill.
 */

import { pool, db } from '../db';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { syncAudit, syncDailyBudget } from '../../shared/schema';
import { logger } from '../logger';
import { recordSquare429ForAlerting } from './squareRateLimitAlert';

/**
 * Maximum number of Square page fetches the historical / backfill paths
 * are allowed to make per UTC day, summed across every sync type.
 *
 * Square pages are typically ≤100 records, so 2,000 pages ≈ 200k records
 * per day — comfortably above legitimate backfill needs and far below
 * what would noticeably impair the rest of the business's Square traffic.
 */
export const MAX_SQUARE_PAGES_PER_DAY = 2000;

/**
 * Distinct 32-bit advisory-lock keys per sync type. Postgres advisory
 * locks are session-scoped, so the locking client must be held until the
 * sync finishes (see `tryAcquireSyncLock`).
 */
/**
 * All historical/backfill flows share a single advisory lock key so that
 * only one such run (regardless of sync type) can hold Square's shared
 * rate budget at any time. The `syncType` argument is preserved on the
 * API for diagnostics and future per-type locks.
 */
const HISTORICAL_BACKFILL_LOCK_KEY = 0x53594e43; // "SYNC"

/**
 * Each recurring (every-60s) sync type gets its OWN distinct advisory-lock
 * key so that, on a multi-instance deployment, only one instance runs a
 * given recurring type at a time — while different types (e.g. orders and
 * payments) still run concurrently within the same cycle. All recurring
 * keys are distinct from `HISTORICAL_BACKFILL_LOCK_KEY`, so a long-running
 * backfill never blocks the recurring cycle and vice versa.
 */
const ADVISORY_LOCK_KEYS: Record<string, number> = {
  // Historical / backfill flows — intentionally share one key (they all draw
  // on the same Square page budget, so only one may run at a time).
  orders_payments_backfill: HISTORICAL_BACKFILL_LOCK_KEY,
  giftCards_historical: HISTORICAL_BACKFILL_LOCK_KEY,
  historical_sync: HISTORICAL_BACKFILL_LOCK_KEY,

  // Recurring (every-60s) syncs — one distinct key each.
  orders: 0x52454301,                 // "REC" + 01
  payments: 0x52454302,               // "REC" + 02
  refunds: 0x52454303,                // "REC" + 03
  giftCards_incremental: 0x52454304,  // "REC" + 04
  gift_card_redemptions: 0x52454305,  // "REC" + 05
  giftCard_redeem_monitor: 0x52454306, // "REC" + 06
  intercard_today: 0x52454307,        // "REC" + 07
};

export interface SyncLock {
  /**
   * Releases the advisory lock and returns the underlying connection to
   * the pool. Idempotent.
   */
  release: () => Promise<void>;
}

/**
 * Try to acquire a Postgres advisory lock for the given sync type. Returns
 * `null` immediately if another process / instance already holds the lock.
 *
 * The caller MUST `release()` once the sync run ends (success or failure)
 * to avoid leaking a pool client.
 */
export async function tryAcquireSyncLock(syncType: string): Promise<SyncLock | null> {
  const key = ADVISORY_LOCK_KEYS[syncType];
  if (key === undefined) {
    throw new Error(`No advisory lock key configured for sync type "${syncType}"`);
  }

  const client = await pool.connect();
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    const locked = r.rows[0]?.locked === true;
    if (!locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      } catch (err) {
        logger.warn('sync.advisory_unlock_failed', {
          syncType,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } finally {
        client.release();
      }
    },
  };
}

export interface AuditStartInput {
  syncType: string;
  action: string;
  actorUserId?: number | null;
  actorIp?: string | null;
  params?: Record<string, unknown> | null;
}

/**
 * Insert a `sync_audit` row marking the start of a backfill / historical
 * sync run. Returns the row id so a matching `recordAuditFinish` call can
 * close it out.
 */
export async function recordAuditStart(input: AuditStartInput): Promise<number> {
  const [row] = await db
    .insert(syncAudit)
    .values({
      syncType: input.syncType,
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      actorIp: input.actorIp ?? null,
      params: input.params ?? null,
      status: 'started',
      pagesUsed: 0,
    })
    .returning({ id: syncAudit.id });
  return row.id;
}

export type AuditFinishStatus = 'completed' | 'failed' | 'rejected' | 'partial';

export interface AuditFinishInput {
  status: AuditFinishStatus;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  pagesUsed?: number;
}

/**
 * Mark an audit row as finished. Safe to call from a `finally` block —
 * any DB error here is logged but not rethrown so it cannot mask the
 * original sync error.
 */
export async function recordAuditFinish(id: number, input: AuditFinishInput): Promise<void> {
  try {
    await db
      .update(syncAudit)
      .set({
        status: input.status,
        result: input.result ?? null,
        errorMessage: input.errorMessage ?? null,
        pagesUsed: input.pagesUsed ?? 0,
        completedAt: new Date(),
      })
      .where(eq(syncAudit.id, id));
  } catch (err) {
    logger.warn('sync.audit_finish_failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * How many days of `sync_daily_budget` history to keep before the
 * trim job (Task #119) deletes them. The table grows by one row per
 * UTC day, so without trimming it would accumulate forever — small
 * in absolute terms, but enough to hide the rolling window an
 * operator scanning the table cares about.
 *
 * 90 days is the smallest window that comfortably covers a quarterly
 * audit lookback while keeping the table small enough to scan by eye.
 */
export const SYNC_DAILY_BUDGET_RETENTION_DAYS = 90;

/**
 * Delete `sync_daily_budget` rows older than `retentionDays` UTC days
 * ago. Returns the count actually deleted plus the cutoff key used,
 * so the scheduler log can prove what was pruned.
 *
 * Concurrency: the underlying DELETE only ever targets rows whose
 * `day` is strictly less than today-minus-N — i.e. an immutable,
 * fixed set of expired keys. Two instances racing this query land on
 * the same target set, so the worst case is a wasted round-trip; no
 * advisory lock is needed. (Documented in the task plan as
 * "DELETE-only-old semantics".)
 */
export async function trimDailyBudget(
  retentionDays: number = SYNC_DAILY_BUDGET_RETENTION_DAYS,
): Promise<{ deleted: number; cutoff: string }> {
  // Defensive lower bound: a caller passing 0 or a negative value
  // would otherwise sweep today's live row out from under the
  // budget enforcer mid-sync. Clamp to at least 1 day of retention
  // so a misconfigured caller can never delete the row that
  // `consumeDailyBudget` is reading right now.
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
  const cutoff = utcDayKey(cutoffDate);

  // `day` is stored as canonical YYYY-MM-DD text, so lex comparison
  // is equivalent to date comparison and Postgres can use the PK
  // index for the range scan.
  const result = await db.execute(sql`
    DELETE FROM sync_daily_budget
    WHERE day < ${cutoff}
  `);

  // node-postgres exposes affected-row count on `rowCount`; drizzle
  // surfaces the same field on the wrapped result. Default to 0 if
  // the driver ever stops reporting it so the return shape stays
  // stable.
  const deleted =
    typeof (result as { rowCount?: number | null }).rowCount === 'number'
      ? ((result as { rowCount?: number | null }).rowCount as number)
      : 0;
  return { deleted, cutoff };
}

/**
 * Snapshot of today's budget consumption for the admin Backfill
 * Audit page widget (Task #119). Returns 0/cap if the day's row
 * hasn't been created yet — that just means no backfill has spent
 * any budget today, NOT that the budget is missing.
 */
export async function getDailyBudgetStatus(): Promise<{
  day: string;
  pagesUsed: number;
  cap: number;
}> {
  const day = utcDayKey();
  const rows = await db
    .select()
    .from(syncDailyBudget)
    .where(eq(syncDailyBudget.day, day))
    .limit(1);
  return {
    day,
    pagesUsed: rows[0]?.pagesUsed ?? 0,
    cap: MAX_SQUARE_PAGES_PER_DAY,
  };
}

/**
 * Atomically reserve `pages` worth of Square page-fetch budget for the
 * current UTC day. Returns `{ ok: false }` if granting the request would
 * push us over `MAX_SQUARE_PAGES_PER_DAY` for the day; the counter is
 * left unchanged in that case so the caller can stop cleanly.
 *
 * `dayOverride` exists solely so the test suite can exercise the
 * conditional-UPDATE guard without mutating today's real budget row in
 * a shared dev DB. Production callers always omit it.
 *
 * No-refund-on-failure contract (Task #120):
 *   Consumed budget is intentionally NOT refunded when the caller
 *   throws after a successful `consumeDailyBudget(...)` call. Square
 *   has already been called (or, at minimum, an attempt was made),
 *   so refunding would let a hostile / buggy retry loop crash
 *   partway through page processing many times in a row and exhaust
 *   the daily cap without ever appearing to spend it. The pessimistic
 *   "consume-up-front, never refund" semantics are a deliberate
 *   security property — see `server/tests/syncLocks.test.ts` for the
 *   regression guard that pins this invariant down so a future
 *   "helpful" rollback refactor can't quietly weaken it.
 */
export async function consumeDailyBudget(
  pages: number,
  dayOverride?: string,
): Promise<{ ok: boolean; used: number; cap: number }> {
  const day = dayOverride ?? utcDayKey();
  // Ensure today's row exists so the conditional UPDATE below has
  // something to operate on.
  await db.execute(sql`
    INSERT INTO sync_daily_budget (day, pages_used, updated_at)
    VALUES (${day}, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (day) DO NOTHING
  `);

  const r = await db.execute(sql`
    UPDATE sync_daily_budget
    SET pages_used = pages_used + ${pages},
        updated_at = CURRENT_TIMESTAMP
    WHERE day = ${day}
      AND pages_used + ${pages} <= ${MAX_SQUARE_PAGES_PER_DAY}
    RETURNING pages_used
  `);

  const rows = (r.rows ?? r) as Array<{ pages_used: number }>;
  if (!rows || rows.length === 0) {
    const cur = await db
      .select()
      .from(syncDailyBudget)
      .where(eq(syncDailyBudget.day, day))
      .limit(1);
    const used = cur[0]?.pagesUsed ?? 0;
    // Single canonical structured warning so operators have ONE grep
    // target (`sync.dailyBudget.rejected`) for "we hit the daily Square
    // page cap" no matter which caller triggered it. Per-caller logs
    // (`sync.historicalGc.budget_exhausted`,
    // `sync.historicalBackfill.budget_exhausted`, …) intentionally stay
    // — they carry caller-specific context like `chunkIndex` — but this
    // line is the source of truth and is emitted unconditionally for
    // every rejection, including from any future caller that forgets to
    // log on its own and from the abusive crash-loop scenario Task #120
    // defended against.
    logger.warn('sync.dailyBudget.rejected', {
      pageCount: pages,
      pagesUsed: used,
      cap: MAX_SQUARE_PAGES_PER_DAY,
      dateStr: day,
    });
    return {
      ok: false,
      used,
      cap: MAX_SQUARE_PAGES_PER_DAY,
    };
  }
  return { ok: true, used: rows[0].pages_used, cap: MAX_SQUARE_PAGES_PER_DAY };
}

/**
 * Outcome of a `withDailyBudget` call. Discriminated on `ok` so TS narrows
 * `result` to the callback's return type only on the success branch.
 */
export type DailyBudgetResult<T> =
  | { ok: true; result: T; used: number; cap: number }
  | { ok: false; used: number; cap: number };

/**
 * Run `callback` only after the daily Square page budget grants `pages`
 * worth of capacity. Enforces the Task #120 "consume *before* the work,
 * never refund on failure" contract by construction:
 *
 *   1. `consumeDailyBudget` is called FIRST, so any caller using this
 *      helper cannot accidentally invert the order ("fetch first, then
 *      consume") and silently bypass the abuse cap.
 *   2. On `{ ok: false }` the callback never runs — Square is not
 *      called and no work happens. The denial is already logged
 *      canonically by `consumeDailyBudget` (Task #163).
 *   3. On `{ ok: true }` the callback runs. ANY throw it produces
 *      propagates unchanged: there is intentionally no try/catch
 *      around the callback here, because catching would either have
 *      to swallow the error (data corruption) or refund the budget
 *      (the very abuse vector Task #120 closed). Letting the throw
 *      escape preserves both contracts simultaneously.
 *
 * Production callers should put their Square API call(s) — and only
 * those — inside the callback. Post-fetch DB work that doesn't itself
 * consume Square pages can stay outside; if a future refactor moves
 * additional Square calls into the same iteration, they belong inside
 * the same `withDailyBudget` block (with the page count summed) so
 * the cap still bounds them.
 */
export async function withDailyBudget<T>(
  pages: number,
  callback: () => Promise<T>,
  dayOverride?: string,
): Promise<DailyBudgetResult<T>> {
  // `dayOverride` mirrors `consumeDailyBudget`'s test-only escape hatch
  // so suite tests of this helper can target a synthetic day key
  // without mutating today's real budget row in a shared dev DB.
  // Production callers always omit it.
  const budget = await consumeDailyBudget(pages, dayOverride);
  if (!budget.ok) {
    return { ok: false, used: budget.used, cap: budget.cap };
  }
  // Deliberately NOT wrapped in try/catch — see contract docstring.
  const result = await callback();
  return { ok: true, result, used: budget.used, cap: budget.cap };
}

/**
 * Detect a Square-API HTTP 429 (rate-limit) error and emit a structured
 * `square.rate_limit_429` warning so it's grep-able in the log store.
 * Returns `true` if the error was a 429 (caller may choose to back off).
 *
 * Safe to call from any catch block; non-429 errors are silently ignored.
 */
export function logIfSquare429(
  err: unknown,
  context: { syncType: string; source: string },
): boolean {
  const e = err as { statusCode?: number; status?: number; response?: { status?: number } } | null | undefined;
  const status = e?.statusCode ?? e?.status ?? e?.response?.status;
  if (status !== 429) return false;
  logger.warn('square.rate_limit_429', {
    syncType: context.syncType,
    source: context.source,
    status: 429,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  // Feed the in-process alerter so on-call gets paged in real time, even
  // before the searchable log store / log-based alert rules land.
  recordSquare429ForAlerting(context.syncType, context.source);
  return true;
}
