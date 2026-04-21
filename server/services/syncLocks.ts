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
const ADVISORY_LOCK_KEYS: Record<string, number> = {
  orders_payments_backfill: HISTORICAL_BACKFILL_LOCK_KEY,
  giftCards_historical: HISTORICAL_BACKFILL_LOCK_KEY,
  historical_sync: HISTORICAL_BACKFILL_LOCK_KEY,
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
 * Atomically reserve `pages` worth of Square page-fetch budget for the
 * current UTC day. Returns `{ ok: false }` if granting the request would
 * push us over `MAX_SQUARE_PAGES_PER_DAY` for the day; the counter is
 * left unchanged in that case so the caller can stop cleanly.
 */
export async function consumeDailyBudget(
  pages: number,
): Promise<{ ok: boolean; used: number; cap: number }> {
  const day = utcDayKey();
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
    return {
      ok: false,
      used: cur[0]?.pagesUsed ?? 0,
      cap: MAX_SQUARE_PAGES_PER_DAY,
    };
  }
  return { ok: true, used: rows[0].pages_used, cap: MAX_SQUARE_PAGES_PER_DAY };
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
  return true;
}
