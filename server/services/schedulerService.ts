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
import { logger, errorContext } from '../logger';

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) {
    logger.info('scheduler.already_running');
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

  logger.info('scheduler.frequent_scheduled');
  logger.info('scheduler.nightly_scheduled');

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
      logger.info('scheduler.startup.phase0', { scanned, linked });
    } catch (err) {
      logger.error('scheduler.startup.phase0_error', errorContext(err));
    }

    try {
      const { inserted } = await giftCardService.syncMissingActivationOrders();
      if (inserted > 0) {
        logger.info('scheduler.startup.phase1', { inserted });
      } else {
        logger.info('scheduler.startup.phase1_noop');
      }
    } catch (err) {
      logger.error('scheduler.startup.phase1_error', errorContext(err));
    }

    try {
      const { cleared, relinked } = await giftCardService.repairMislinkedActivationOrders();
      if (cleared > 0 || relinked > 0) {
        logger.info('scheduler.startup.phase1_5', { relinked, cleared });
      }
    } catch (err) {
      logger.error('scheduler.startup.phase1_5_error', errorContext(err));
    }

    try {
      const { updated } = await giftCardService.backfillActivationSquareOrderIds();
      if (updated > 0) {
        logger.info('scheduler.startup.phase2', { updated });
      } else {
        logger.info('scheduler.startup.phase2_noop');
      }
    } catch (err) {
      logger.error('scheduler.startup.phase2_error', errorContext(err));
    }
  })();

  // On startup: if the historical gift card backfill has never completed,
  // run it in the background until finished so the dashboard has complete data.
  runBackfillUntilComplete().catch(err => {
    logger.error('scheduler.startup.error', errorContext(err));
  });

  // On startup: auto-resume the historical orders/payments backfill if it was
  // in progress when the server last stopped (e.g. restart mid-chunk).
  resumeHistoricalOrdersPaymentsBackfillIfNeeded().catch(err => {
    logger.error('scheduler.ordersPayments_resume_error', errorContext(err));
  });

  setTimeout(() => {
    backfill2024OrdersIfNeeded().catch(err => {
      logger.error('scheduler.2024_orders_error', errorContext(err));
    });
  }, 15000);

  // On startup: sync payout fee data (non-blocking)
  (async () => {
    try {
      logger.info('scheduler.payoutFee.start');
      const result = await payoutService.syncPayoutFeesIncremental();
      logger.info('scheduler.payoutFee.done', { payoutsProcessed: result.payoutsProcessed, entriesCreated: result.entriesCreated });
    } catch (err) {
      logger.error('scheduler.payoutFee.error', errorContext(err));
    }
  })();

  // On startup: run Intercard historical backfill if not yet complete (non-blocking)
  (async () => {
    try {
      logger.info('scheduler.intercard.start');
      await intercardService.runHistoricalBackfill();
    } catch (err) {
      logger.error('scheduler.intercard.error', errorContext(err));
    }
  })();
}

async function backfill2024OrdersIfNeeded(): Promise<void> {
  const SYNC_KEY = 'orders_backfill_2024';
  const state = await syncService.getSyncState(SYNC_KEY);
  if (state?.isComplete && state.status === 'completed') {
    logger.info('scheduler.2024.already_complete');
    return;
  }

  const { pool } = await import('../db');
  const countResult = await pool.query(
    `SELECT COUNT(*) as cnt FROM orders WHERE created_at >= '2024-03-01' AND created_at < '2025-01-01'`
  );
  const orderCount = parseInt(countResult.rows[0]?.cnt || '0', 10);
  if (orderCount > 10000) {
    logger.info('scheduler.2024.already_present', { orderCount });
    if (state) {
      await syncService.updateSyncState(state.id, { isComplete: true, status: 'completed', lastSyncedAt: new Date() });
    } else {
      await syncService.createSyncState({ syncType: SYNC_KEY, lastSyncedAt: new Date(), isComplete: true, status: 'completed' });
    }
    return;
  }

  const primaryBackfill = await syncService.getSyncState('orders_payments_backfill');
  if (primaryBackfill && !primaryBackfill.isComplete) {
    logger.info('scheduler.2024.deferred');
    return;
  }

  logger.info('scheduler.2024.start');

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
    logger.info('scheduler.2024.queued', { reason: result.message });

    if (!result.alreadyRunning) {
      const checkComplete = async () => {
        for (let i = 0; i < 600; i++) {
          await new Promise(r => setTimeout(r, 10000));
          const status = await syncService.getHistoricalBackfillStatus();
          if (status.isComplete || status.status === 'completed') {
            logger.info('scheduler.2024.complete');
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
        logger.warn('scheduler.2024.timeout');
      };
      checkComplete().catch(err => logger.error('scheduler.2024.monitor_error', errorContext(err)));
    }
  } catch (err) {
    logger.error('scheduler.2024.failed', errorContext(err));
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
    logger.info('scheduler.ordersPayments.already_complete');
    return;
  }
  if (state.isComplete) return;

  const cp = state.lastCheckpoint as any ?? {};
  const startDate = cp.startDate ? new Date(cp.startDate) : new Date('2025-01-01T00:00:00Z');
  const endDate   = cp.endDate   ? new Date(cp.endDate)   : new Date();
  const chunkDays = 30;

  logger.info('scheduler.ordersPayments.resume', { chunksCompleted: cp.chunksCompleted ?? 0, totalChunks: cp.totalChunks ?? null });

  // Reset the stuck-detection timestamp so the guard lets us restart immediately
  await syncService.updateSyncState(state.id, {
    lastSyncedAt: new Date(0),
  });

  try {
    const result = await syncService.startHistoricalOrdersPaymentsBackfill(startDate, endDate, chunkDays);
    logger.info('scheduler.ordersPayments.resumed', { reason: result.message });
  } catch (err) {
    logger.error('scheduler.ordersPayments.resume_failed', errorContext(err));
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
    logger.info('scheduler.giftCardHistorical.already_complete');
    return;
  }

  logger.info('scheduler.giftCardHistorical.start');
  let callCount = 0;
  const MAX_CALLS = 50; // safety cap — prevents infinite loops

  while (callCount < MAX_CALLS) {
    callCount++;
    try {
      const result = await syncService.syncGiftCardsHistoricalBackfill();
      logger.info('scheduler.giftCardHistorical.pass', { callCount, processed: result.processed, created: result.created, updated: result.updated, pagesProcessed: result.pagesProcessed, finished: result.finished });
      if (result.finished) {
        logger.info('scheduler.giftCardHistorical.complete');
        return;
      }
      // Brief pause between passes to avoid overwhelming Square API
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      logger.error('scheduler.giftCardHistorical.pass_failed', { ...errorContext(err), callCount });
      // Wait 30 seconds before retrying after an error
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
  logger.warn('scheduler.giftCardHistorical.safety_cap', { maxCalls: MAX_CALLS });
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
      logger.info('scheduler.run.payments', { label, created: result.created, updated: result.updated });
    }
  } catch (err) {
    logger.error('scheduler.run.payments_failed', { ...errorContext(err), label });
  }

  try {
    const result = await syncService.syncOrders(startOfTodayET);
    if (result.created > 0 || result.updated > 0) {
      logger.info('scheduler.run.orders', { label, created: result.created, updated: result.updated });
    }
  } catch (err) {
    logger.error('scheduler.run.orders_failed', { ...errorContext(err), label });
  }

  try {
    const result = await syncService.syncIncrementalGiftCards();
    if (result.created > 0 || result.updated > 0) {
      logger.info('scheduler.run.giftCardIncremental', { label, created: result.created, updated: result.updated, sinceDate: result.sinceDate });
    }
  } catch (err) {
    logger.error('scheduler.run.giftCardIncremental_failed', { ...errorContext(err), label });
  }

  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  try {
    const result = await syncService.syncRefunds(fifteenMinutesAgo);
    if (result.created > 0 || result.updated > 0) {
      logger.info('scheduler.run.refunds', { label, created: result.created, updated: result.updated });
    }
  } catch (err) {
    logger.error('scheduler.run.refunds_failed', { ...errorContext(err), label });
  }

  try {
    await intercardService.syncToday();
  } catch (err) {
    logger.error('scheduler.run.intercard_failed', { ...errorContext(err), label });
  }

  try {
    const result = await syncService.syncGiftCardRedemptions(startOfTodayET);
    if (result.created > 0) {
      logger.info('scheduler.run.giftCardRedemptions', { label, created: result.created });
    }
    if (result.redeemedGiftCardIds && result.redeemedGiftCardIds.length > 0) {
      try {
        const uniqueIds = Array.from(new Set(result.redeemedGiftCardIds));
        const refreshResult = await giftCardService.refreshGiftCardBalancesByIds(uniqueIds);
      logger.info('scheduler.run.giftCardRedemption_refreshed', { label, updated: refreshResult.updated });
      } catch (refreshErr) {
        logger.error('scheduler.run.giftCardRedemption_refresh_failed', { ...errorContext(refreshErr), label });
      }
    }
  } catch (err) {
    logger.error('scheduler.run.giftCardRedemptions_failed', { ...errorContext(err), label });
  }

  try {
    const result = await syncService.syncRedeemActivityBalances();
    if (result.redeemEvents > 0) {
      logger.info('scheduler.run.redeemMonitor', { label, redeemEvents: result.redeemEvents, cardsRefreshed: result.cardsRefreshed });
    }
  } catch (err) {
    logger.error('scheduler.run.redeemMonitor_failed', { ...errorContext(err), label });
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
  logger.info('scheduler.nightly.start', { label });

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  try {
    logger.info('scheduler.nightly.step0_start', { label });
    const br = await giftCardService.refreshAllGiftCardBalances();
    logger.info('scheduler.nightly.step0_done', { label, updated: br.updated, total: br.total });
  } catch (err) {
    logger.error('scheduler.nightly.step0_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.step1_start', { label });
    const r = await syncService.syncGiftCardsHistoricalBackfill();
    logger.info('scheduler.nightly.step1_done', { label, processed: r.processed, created: r.created, updated: r.updated, failed: r.failed, pagesProcessed: r.pagesProcessed, finished: r.finished });
  } catch (err) {
    logger.error('scheduler.nightly.step1_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.step2_start', { label });
    const r = await syncService.syncPayments(threeDaysAgo);
    logger.info('scheduler.nightly.step2_done', { label, processed: r.processed, created: r.created, updated: r.updated, failed: r.failed });
  } catch (err) {
    logger.error('scheduler.nightly.step2_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.step3_start', { label });
    const r = await syncService.syncOrders(threeDaysAgo);
    logger.info('scheduler.nightly.step3_done', { label, processed: r.processed, created: r.created, updated: r.updated, failed: r.failed });
  } catch (err) {
    logger.error('scheduler.nightly.step3_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.step4_start', { label });
    const rr = await syncService.syncRefunds(threeDaysAgo);
    logger.info('scheduler.nightly.step4_done', { label, processed: rr.processed, created: rr.created, updated: rr.updated, failed: rr.failed });
  } catch (err) {
    logger.error('scheduler.nightly.step4_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.step5_start', { label });
    const r = await backfillGiftCardActivationAmounts();
    logger.info('scheduler.nightly.step5_done', { label, filled: r.updatedViaActivitiesApi, corrected: r.correctedViaActivitiesApi, unresolved: r.stillUnresolved });
  } catch (err) {
    logger.error('scheduler.nightly.step5_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.phase0_start', { label });
    const r = await giftCardService.backfillActivationOrderIdsFromActivateHistory();
    logger.info('scheduler.nightly.phase0_done', { label, scanned: r.scanned, linked: r.linked });
  } catch (err) {
    logger.error('scheduler.nightly.phase0_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.phase1_start', { label });
    const r = await giftCardService.syncMissingActivationOrders();
    logger.info('scheduler.nightly.phase1_done', { label, inserted: r.inserted });
  } catch (err) {
    logger.error('scheduler.nightly.phase1_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.phase1_5_start', { label });
    const repair = await giftCardService.repairMislinkedActivationOrders();
    if (repair.cleared > 0 || repair.relinked > 0) {
      logger.info('scheduler.nightly.phase1_5_done', { label, relinked: repair.relinked, cleared: repair.cleared });
    }
  } catch (err) {
    logger.error('scheduler.nightly.phase1_5_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.phase2_start', { label });
    const r = await giftCardService.backfillActivationSquareOrderIds();
    logger.info('scheduler.nightly.phase2_done', { label, updated: r.updated });
  } catch (err) {
    logger.error('scheduler.nightly.phase2_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.payoutFee_start', { label });
    const r = await payoutService.syncPayoutFeesIncremental();
    logger.info('scheduler.nightly.payoutFee_done', { label, payoutsProcessed: r.payoutsProcessed, entriesCreated: r.entriesCreated });
  } catch (err) {
    logger.error('scheduler.nightly.payoutFee_failed', { ...errorContext(err), label });
  }

  try {
    logger.info('scheduler.nightly.intercard_start', { label });
    await intercardService.syncToday();
    logger.info('scheduler.nightly.intercard_done', { label });
  } catch (err) {
    logger.error('scheduler.nightly.intercard_failed', { ...errorContext(err), label });
  }

  logger.info('scheduler.nightly.complete', { label });

  broadcast('data-updated', { syncType: 'nightly' });
}
