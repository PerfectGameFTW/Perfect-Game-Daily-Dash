/**
 * Scheduler Service
 *
 * Two sync schedules:
 *
 * EVERY 60 SECONDS — keeps the dashboard current throughout the day:
 *   1. Payments  — full current day (Eastern) to catch tip adjustments
 *   2. Orders    — full current day (Eastern) to catch mid-day edits
 *   3. Gift cards — INCREMENTAL: only fetches ACTIVATE events since last sync
 *      (fast, seconds not minutes; new cards appear within one cycle)
 *
 * NIGHTLY 3 AM ET — slower housekeeping:
 *   1. Gift cards — full Square list scan for reconciliation
 *   2. Payments  — last 3 days (catches anything the 5-min runs may have missed)
 *   3. Orders    — last 3 days
 *   4. Activation backfill — fills null activation amounts via Activities API
 */

import cron from 'node-cron';
import { syncService } from './syncService';
import { backfillGiftCardActivationAmounts } from './enhancedGiftCardFix';
import { giftCardService } from './giftCardService';
import { payoutService } from './payoutService';
import { intercardService } from './intercardService';
import { broadcast } from '../ws';

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) {
    console.log('[Scheduler] Already running — skipping second start');
    return;
  }
  schedulerStarted = true;

  // Every 60 seconds — real-time dashboard freshness
  cron.schedule('* * * * *', runFrequentSync, {
    timezone: 'America/New_York',
  });

  // 3 AM nightly — deep sync + activation backfill
  cron.schedule('0 3 * * *', runNightlySync, {
    timezone: 'America/New_York',
  });

  console.log('[Scheduler] Frequent sync scheduled every 60 seconds');
  console.log('[Scheduler] Nightly deep sync scheduled at 3:00 AM Eastern Time');

  // On startup: three-phase activation_square_order_id backfill (non-blocking, idempotent).
  //
  // Phase 0 (primary): Scan ALL Square ACTIVATE events for orderId. Runs with its own
  //          sync state key ('gift_card_order_id_history') independent of the historical
  //          backfill. Resumable across restarts. ACTIVATE-event-derived links are
  //          authoritative and never overwritten by later phases.
  //
  // Phase 1: For cards that got orderId in Phase 0 (or from previous backfills), fetch
  //          any referenced orders missing from the local orders table so the LEFT JOIN
  //          in getGiftCardBreakdown() can resolve them.
  //
  // Phase 2 (fallback): For cards where Square's ACTIVATE events did NOT return an orderId
  //          (NULL after Phase 0), use a time+amount proximity heuristic against Web
  //          Reservation orders in the DB. Only touches rows still NULL after Phase 0.
  (async () => {
    try {
      const { scanned, linked } = await giftCardService.backfillActivationOrderIdsFromActivateHistory();
      console.log(`[Scheduler] Phase 0 (ACTIVATE history scan): ${scanned} events, ${linked} order IDs linked`);
    } catch (err) {
      console.error('[Scheduler] Phase 0 (ACTIVATE history scan) error:', err);
    }

    try {
      const { inserted } = await giftCardService.syncMissingActivationOrders();
      if (inserted > 0) {
        console.log(`[Scheduler] Phase 1 (missing-order sync): ${inserted} order(s) fetched from Square`);
      } else {
        console.log('[Scheduler] Phase 1 (missing-order sync): nothing to fetch');
      }
    } catch (err) {
      console.error('[Scheduler] Phase 1 (missing-order sync) error:', err);
    }

    try {
      const { updated } = await giftCardService.backfillActivationSquareOrderIds();
      if (updated > 0) {
        console.log(`[Scheduler] Phase 2 (heuristic backfill): ${updated} gift card(s) linked to Web Reservation orders`);
      } else {
        console.log('[Scheduler] Phase 2 (heuristic backfill): all gift cards already linked — nothing to do');
      }
    } catch (err) {
      console.error('[Scheduler] Phase 2 (heuristic backfill) error:', err);
    }
  })();

  // On startup: if the historical gift card backfill has never completed,
  // run it in the background until finished so the dashboard has complete data.
  runBackfillUntilComplete().catch(err => {
    console.error('[Scheduler] Startup backfill error:', err);
  });

  // On startup: auto-resume the historical orders/payments backfill if it was
  // in progress when the server last stopped (e.g. restart mid-chunk).
  resumeHistoricalOrdersPaymentsBackfillIfNeeded().catch(err => {
    console.error('[Scheduler] Orders/payments backfill resume error:', err);
  });

  setTimeout(() => {
    backfill2024OrdersIfNeeded().catch(err => {
      console.error('[Scheduler] 2024 orders backfill error:', err);
    });
  }, 15000);

  // On startup: sync payout fee data (non-blocking)
  (async () => {
    try {
      console.log('[Scheduler] Starting payout fee sync in background...');
      const result = await payoutService.syncPayoutFeesIncremental();
      console.log(`[Scheduler] Payout fees synced: ${result.payoutsProcessed} payouts, ${result.entriesCreated} entries`);
    } catch (err) {
      console.error('[Scheduler] Payout fee sync error:', err);
    }
  })();

  // On startup: run Intercard historical backfill if not yet complete (non-blocking)
  (async () => {
    try {
      console.log('[Scheduler] Starting Intercard historical backfill in background...');
      await intercardService.runHistoricalBackfill();
    } catch (err) {
      console.error('[Scheduler] Intercard backfill error:', err);
    }
  })();
}

async function backfill2024OrdersIfNeeded(): Promise<void> {
  const SYNC_KEY = 'orders_backfill_2024';
  const state = await syncService.getSyncState(SYNC_KEY);
  if (state?.isComplete && state.status === 'completed') {
    console.log('[Scheduler] 2024 historical orders backfill already complete — skipping');
    return;
  }

  const { pool } = await import('../db');
  const countResult = await pool.query(
    `SELECT COUNT(*) as cnt FROM orders WHERE created_at >= '2024-03-01' AND created_at < '2025-01-01'`
  );
  const orderCount = parseInt(countResult.rows[0]?.cnt || '0', 10);
  if (orderCount > 10000) {
    console.log(`[Scheduler] 2024 orders already present (${orderCount} orders) — marking complete and skipping`);
    if (state) {
      await syncService.updateSyncState(state.id, { isComplete: true, status: 'completed', lastSyncedAt: new Date() });
    } else {
      await syncService.createSyncState({ syncType: SYNC_KEY, lastSyncedAt: new Date(), isComplete: true, status: 'completed' });
    }
    return;
  }

  const primaryBackfill = await syncService.getSyncState('orders_payments_backfill');
  if (primaryBackfill && !primaryBackfill.isComplete) {
    console.log('[Scheduler] Primary backfill still running — deferring 2024 backfill to next restart');
    return;
  }

  console.log('[Scheduler] Starting 2024 historical orders backfill (Mar 2024 – Dec 2024)...');

  const startDate = new Date('2024-03-01T00:00:00Z');
  const endDate = new Date('2025-01-01T00:00:00Z');

  if (primaryBackfill) {
    await syncService.updateSyncState(primaryBackfill.id, {
      isComplete: false,
      status: 'in_progress',
      lastSyncedAt: new Date(0),
      lastCheckpoint: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        chunkDays: 30,
        totalChunks: 0,
        nextChunkToProcess: 0,
        chunksCompleted: 0,
        lastCompletedDate: null,
      },
    });
  }

  try {
    const result = await syncService.startHistoricalOrdersPaymentsBackfill(startDate, endDate, 30);
    console.log(`[Scheduler] 2024 backfill: ${result.message}`);

    if (!result.alreadyRunning) {
      const checkComplete = async () => {
        for (let i = 0; i < 600; i++) {
          await new Promise(r => setTimeout(r, 10000));
          const status = await syncService.getHistoricalBackfillStatus();
          if (status.isComplete || status.status === 'completed') {
            console.log('[Scheduler] 2024 backfill complete — marking sync key');
            const existingKey = await syncService.getSyncState(SYNC_KEY);
            if (existingKey) {
              await syncService.updateSyncState(existingKey.id, {
                isComplete: true,
                status: 'completed',
                lastSyncedAt: new Date(),
              });
            } else {
              await syncService.createSyncState({
                syncType: SYNC_KEY,
                lastSyncedAt: new Date(),
                isComplete: true,
                status: 'completed',
              });
            }
            return;
          }
        }
        console.warn('[Scheduler] 2024 backfill timed out waiting for completion');
      };
      checkComplete().catch(err => console.error('[Scheduler] 2024 backfill monitor error:', err));
    }
  } catch (err) {
    console.error('[Scheduler] 2024 backfill failed:', err);
  }
}

/**
 * If a historical orders/payments backfill was started but not yet completed,
 * automatically resume it so server restarts don't stall the backfill.
 */
async function resumeHistoricalOrdersPaymentsBackfillIfNeeded(): Promise<void> {
  const state = await syncService.getSyncState('orders_payments_backfill');
  if (!state) return;
  if (state.isComplete && state.status === 'completed') {
    console.log('[Scheduler] Historical orders/payments backfill already complete — skipping resume');
    return;
  }
  if (state.isComplete) return;

  const cp = state.lastCheckpoint as any ?? {};
  const startDate = cp.startDate ? new Date(cp.startDate) : new Date('2025-01-01T00:00:00Z');
  const endDate   = cp.endDate   ? new Date(cp.endDate)   : new Date();
  const chunkDays = 30;

  console.log(`[Scheduler] Resuming historical orders/payments backfill from chunk ${cp.chunksCompleted ?? 0} of ${cp.totalChunks ?? '?'}`);

  // Reset the stuck-detection timestamp so the guard lets us restart immediately
  await syncService.updateSyncState(state.id, {
    lastSyncedAt: new Date(0),
  });

  try {
    const result = await syncService.startHistoricalOrdersPaymentsBackfill(startDate, endDate, chunkDays);
    console.log(`[Scheduler] Backfill resumed: ${result.message}`);
  } catch (err) {
    console.error('[Scheduler] Failed to resume backfill:', err);
  }
}

/**
 * Runs the gift card historical backfill in a loop until finished.
 * Called once on startup (background, non-blocking).
 * Skips immediately if the backfill was already completed in a previous run.
 */
async function runBackfillUntilComplete(): Promise<void> {
  // Check if backfill is already done before doing any API work
  const existingState = await syncService.getSyncState('giftCards_historical');
  if (existingState?.isComplete && existingState.status === 'completed') {
    console.log('[Scheduler] Gift card historical backfill already complete — skipping startup run');
    return;
  }

  console.log('[Scheduler] Starting gift card historical backfill in background...');
  let callCount = 0;
  const MAX_CALLS = 50; // safety cap — prevents infinite loops

  while (callCount < MAX_CALLS) {
    callCount++;
    try {
      const result = await syncService.syncGiftCardsHistoricalBackfill();
      console.log(`[Scheduler] Backfill pass ${callCount}: processed=${result.processed} created=${result.created} updated=${result.updated} pages=${result.pagesProcessed} finished=${result.finished}`);
      if (result.finished) {
        console.log('[Scheduler] Gift card historical backfill complete.');
        return;
      }
      // Brief pause between passes to avoid overwhelming Square API
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      console.error(`[Scheduler] Backfill pass ${callCount} failed:`, err);
      // Wait 30 seconds before retrying after an error
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
  console.warn(`[Scheduler] Backfill reached safety cap of ${MAX_CALLS} calls — will continue at next nightly run`);
}

/**
 * Runs every 5 minutes.
 * Syncs all of today's payments and orders (Eastern time) so tip adjustments,
 * voided payments, and other mid-day edits are always current.
 * Gift cards use the fast incremental path: only ACTIVATE events since the
 * last incremental sync are fetched, so new cards appear within one cycle.
 */
export async function runFrequentSync(): Promise<void> {
  const label = `[Sync ${new Date().toISOString()}]`;

  // Use start-of-today (Eastern) as the lookback for payments and orders so
  // tip adjustments, voided payments, and other mid-day edits are picked up
  // on every cycle — not just within a 15-minute window.
  const startOfTodayET = getStartOfBusinessDayEastern();

  try {
    const result = await syncService.syncPayments(startOfTodayET);
    if (result.created > 0 || result.updated > 0) {
      console.log(`${label} Payments: +${result.created} new, ${result.updated} updated`);
    }
  } catch (err) {
    console.error(`${label} Payments sync failed:`, err);
  }

  try {
    const result = await syncService.syncOrders(startOfTodayET);
    if (result.created > 0 || result.updated > 0) {
      console.log(`${label} Orders: +${result.created} new, ${result.updated} updated`);
    }
  } catch (err) {
    console.error(`${label} Orders sync failed:`, err);
  }

  try {
    const result = await syncService.syncIncrementalGiftCards();
    if (result.created > 0 || result.updated > 0) {
      console.log(`${label} Gift cards (incremental): +${result.created} new, ${result.updated} updated (since ${result.sinceDate})`);
    }
  } catch (err) {
    console.error(`${label} Incremental gift card sync failed:`, err);
  }

  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  try {
    const result = await syncService.syncRefunds(fifteenMinutesAgo);
    if (result.created > 0 || result.updated > 0) {
      console.log(`${label} Refunds: +${result.created} new, ${result.updated} updated`);
    }
  } catch (err) {
    console.error(`${label} Refunds sync failed:`, err);
  }

  try {
    await intercardService.syncToday();
  } catch (err) {
    console.error(`${label} Intercard sync failed:`, err);
  }

  try {
    const result = await syncService.syncGiftCardRedemptions(startOfTodayET);
    if (result.created > 0) {
      console.log(`${label} Gift card redemptions: +${result.created} new`);
    }
    if (result.redeemedGiftCardIds && result.redeemedGiftCardIds.length > 0) {
      try {
        const uniqueIds = Array.from(new Set(result.redeemedGiftCardIds));
        const refreshResult = await giftCardService.refreshGiftCardBalancesByIds(uniqueIds);
        console.log(`${label} Refreshed ${refreshResult.updated} redeemed gift card balance(s)`);
      } catch (refreshErr) {
        console.error(`${label} Gift card balance refresh failed (non-fatal):`, refreshErr);
      }
    }
  } catch (err) {
    console.error(`${label} Gift card redemptions sync failed:`, err);
  }

  broadcast('data-updated', { syncType: 'frequent' });
}

function getStartOfBusinessDayEastern(): Date {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const businessDayStart = new Date(eastern);
  businessDayStart.setHours(6, 0, 0, 0);
  if (eastern < businessDayStart) {
    businessDayStart.setDate(businessDayStart.getDate() - 1);
  }
  const diffMs = eastern.getTime() - businessDayStart.getTime();
  return new Date(now.getTime() - diffMs);
}

/**
 * Runs at 3 AM Eastern every night.
 * Wider lookback window plus the activation backfill for any cards
 * whose original activation amounts still need to be resolved.
 */
export async function runNightlySync(): Promise<void> {
  const label = `[Nightly ${new Date().toISOString()}]`;
  console.log(`${label} Starting nightly deep sync...`);

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  try {
    console.log(`${label} Step 0: Gift card balance refresh (all cards from Square)`);
    const br = await giftCardService.refreshAllGiftCardBalances();
    console.log(`${label} Balance refresh: updated=${br.updated} total=${br.total}`);
  } catch (err) {
    console.error(`${label} Gift card balance refresh failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 1/4: Gift card full reconciliation (Activities API)`);
    const r = await syncService.syncGiftCardsHistoricalBackfill();
    console.log(`${label} Gift cards: processed=${r.processed} created=${r.created} updated=${r.updated} failed=${r.failed} pages=${r.pagesProcessed} finished=${r.finished}`);
  } catch (err) {
    console.error(`${label} Gift card sync failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 2/4: Payments sync (last 3 days)`);
    const r = await syncService.syncPayments(threeDaysAgo);
    console.log(`${label} Payments: processed=${r.processed} created=${r.created} updated=${r.updated} failed=${r.failed}`);
  } catch (err) {
    console.error(`${label} Payments sync failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 3/4: Orders sync (last 3 days)`);
    const r = await syncService.syncOrders(threeDaysAgo);
    console.log(`${label} Orders: processed=${r.processed} created=${r.created} updated=${r.updated} failed=${r.failed}`);
  } catch (err) {
    console.error(`${label} Orders sync failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 4/8: Refunds sync (last 3 days)`);
    const rr = await syncService.syncRefunds(threeDaysAgo);
    console.log(`${label} Refunds: processed=${rr.processed} created=${rr.created} updated=${rr.updated} failed=${rr.failed}`);
  } catch (err) {
    console.error(`${label} Refunds sync failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 5/8: Activation amount backfill`);
    const r = await backfillGiftCardActivationAmounts();
    console.log(`${label} Backfill: filled=${r.updatedViaActivitiesApi} corrected=${r.correctedViaActivitiesApi} unresolved=${r.stillUnresolved}`);
  } catch (err) {
    console.error(`${label} Activation backfill failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 5/6: Phase 0 — ACTIVATE history scan for order IDs`);
    const r = await giftCardService.backfillActivationOrderIdsFromActivateHistory();
    console.log(`${label} Phase 0: ${r.scanned} events scanned, ${r.linked} order IDs linked`);
  } catch (err) {
    console.error(`${label} Phase 0 (ACTIVATE history scan) failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 5b/6: Phase 1 — Sync missing activation orders from Square`);
    const r = await giftCardService.syncMissingActivationOrders();
    console.log(`${label} Phase 1: ${r.inserted} missing order(s) inserted`);
  } catch (err) {
    console.error(`${label} Phase 1 (missing-order sync) failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 6/6: Phase 2 — Heuristic backfill (fallback)`);
    const r = await giftCardService.backfillActivationSquareOrderIds();
    console.log(`${label} Phase 2: ${r.updated} gift card(s) linked via heuristic`);
  } catch (err) {
    console.error(`${label} Phase 2 (heuristic backfill) failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Payout fee sync`);
    const r = await payoutService.syncPayoutFeesIncremental();
    console.log(`${label} Payout fees: ${r.payoutsProcessed} payouts, ${r.entriesCreated} entries`);
  } catch (err) {
    console.error(`${label} Payout fee sync failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Intercard revenue sync`);
    await intercardService.syncToday();
    console.log(`${label} Intercard revenue synced`);
  } catch (err) {
    console.error(`${label} Intercard sync failed (non-fatal):`, err);
  }

  console.log(`${label} Nightly deep sync complete.`);

  broadcast('data-updated', { syncType: 'nightly' });
}
