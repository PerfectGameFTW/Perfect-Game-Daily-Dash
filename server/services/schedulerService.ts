/**
 * Scheduler Service
 *
 * Two sync schedules:
 *
 * EVERY 5 MINUTES — keeps the dashboard current throughout the day:
 *   1. Payments  — last 15 minutes (3x the interval for safe overlap)
 *   2. Orders    — last 15 minutes
 *   3. Gift cards — INCREMENTAL: only fetches ACTIVATE events since last sync
 *      (fast, seconds not minutes; new cards appear within one 5-min cycle)
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

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) {
    console.log('[Scheduler] Already running — skipping second start');
    return;
  }
  schedulerStarted = true;

  // Every 5 minutes — real-time dashboard freshness
  cron.schedule('*/5 * * * *', runFrequentSync, {
    timezone: 'America/New_York',
  });

  // 3 AM nightly — deep sync + activation backfill
  cron.schedule('0 3 * * *', runNightlySync, {
    timezone: 'America/New_York',
  });

  console.log('[Scheduler] Frequent sync scheduled every 5 minutes');
  console.log('[Scheduler] Nightly deep sync scheduled at 3:00 AM Eastern Time');

  // On startup: two-phase activation_square_order_id backfill (non-blocking, idempotent).
  //
  // Phase 1: For gift cards where Square's ACTIVATE events DID return an orderId
  //          (written by the historical backfill), fetch any referenced orders that
  //          are missing from our local orders table so the LEFT JOIN in
  //          getGiftCardBreakdown() can resolve them.
  //
  // Phase 2: For gift cards where Square's ACTIVATE events did NOT return an orderId,
  //          use a time+amount proximity heuristic against Web Reservation orders already
  //          in our DB to establish the link.
  (async () => {
    try {
      const { inserted } = await giftCardService.syncMissingActivationOrders();
      if (inserted > 0) {
        console.log(`[Scheduler] Synced ${inserted} missing activation order(s) from Square`);
      } else {
        console.log('[Scheduler] Missing-order sync: nothing to fetch');
      }
    } catch (err) {
      console.error('[Scheduler] Missing-order sync error:', err);
    }

    try {
      const { updated } = await giftCardService.backfillActivationSquareOrderIds();
      if (updated > 0) {
        console.log(`[Scheduler] Order-ID backfill complete: ${updated} gift card(s) linked to Web Reservation orders`);
      } else {
        console.log('[Scheduler] Order-ID backfill: all gift cards already linked — nothing to do');
      }
    } catch (err) {
      console.error('[Scheduler] Order-ID backfill error:', err);
    }
  })();

  // On startup: if the historical gift card backfill has never completed,
  // run it in the background until finished so the dashboard has complete data.
  runBackfillUntilComplete().catch(err => {
    console.error('[Scheduler] Startup backfill error:', err);
  });
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
 * Syncs payments and orders for the last 15 minutes.
 * Gift cards use the fast incremental path: only ACTIVATE events since the
 * last incremental sync are fetched, so new cards appear within one cycle.
 */
export async function runFrequentSync(): Promise<void> {
  const label = `[Sync ${new Date().toISOString()}]`;
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  try {
    const result = await syncService.syncPayments(fifteenMinutesAgo);
    if (result.created > 0 || result.updated > 0) {
      console.log(`${label} Payments: +${result.created} new, ${result.updated} updated`);
    }
  } catch (err) {
    console.error(`${label} Payments sync failed:`, err);
  }

  try {
    const result = await syncService.syncOrders(fifteenMinutesAgo);
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

  // Step 1: Run the resumable Activities-API-based full reconciliation.
  // This replaces the old syncGiftCards() (which used listGiftCards — no date filter,
  // arbitrary order, loses progress on server restart).  The new method pages through
  // ALL ACTIVATE events ASC, checkpointing after each page so restarts resume mid-scan.
  // If the scan is not finished in one nightly run it will continue the next night.
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
    console.log(`${label} Step 4/4: Activation amount backfill`);
    const r = await backfillGiftCardActivationAmounts();
    console.log(`${label} Backfill: filled=${r.updatedViaActivitiesApi} corrected=${r.correctedViaActivitiesApi} unresolved=${r.stillUnresolved}`);
  } catch (err) {
    console.error(`${label} Activation backfill failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 5a/6: Sync missing activation orders from Square`);
    const r = await giftCardService.syncMissingActivationOrders();
    console.log(`${label} Missing-order sync: ${r.inserted} order(s) inserted`);
  } catch (err) {
    console.error(`${label} Missing-order sync failed (non-fatal):`, err);
  }

  try {
    console.log(`${label} Step 5b/6: Order-ID backfill (link gift cards to Web Res orders)`);
    const r = await giftCardService.backfillActivationSquareOrderIds();
    console.log(`${label} Order-ID backfill: ${r.updated} gift card(s) linked`);
  } catch (err) {
    console.error(`${label} Order-ID backfill failed (non-fatal):`, err);
  }

  console.log(`${label} Nightly deep sync complete.`);
}
