/**
 * Scheduler Service
 *
 * Runs nightly automatic syncs so dashboard data never goes stale.
 * Schedule: 3 AM Eastern Time every night.
 *
 * What it does each run:
 *  1. Gift card sync — fetches ALL active cards from Square so new cards appear.
 *  2. Payments sync  — last 3 days, catches any stragglers not picked up in real time.
 *  3. Orders sync    — last 3 days.
 *  4. Activation backfill — fills any null activation amounts via the Activities API.
 */

import cron from 'node-cron';
import { syncService } from './syncService';
import { backfillGiftCardActivationAmounts } from './enhancedGiftCardFix';

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) {
    console.log('[Scheduler] Already running — skipping second start');
    return;
  }
  schedulerStarted = true;

  // "0 3 * * *" = 3:00 AM every day
  // timezone: America/New_York keeps this anchored to Eastern Time through DST changes
  cron.schedule('0 3 * * *', runNightlySync, {
    timezone: 'America/New_York',
  });

  console.log('[Scheduler] Nightly sync scheduled at 3:00 AM Eastern Time');
}

export async function runNightlySync(): Promise<void> {
  const label = `[Scheduler ${new Date().toISOString()}]`;
  console.log(`${label} Starting nightly sync...`);

  try {
    // 1. Gift card sync — fetches the full Square gift card list so newly issued
    //    cards (with their correct purchase dates) appear in the DB.
    console.log(`${label} Step 1/4: Gift card sync`);
    const gcResult = await syncService.syncGiftCards();
    console.log(`${label} Gift cards: processed=${gcResult.processed} created=${gcResult.created} updated=${gcResult.updated} failed=${gcResult.failed}`);
  } catch (err) {
    console.error(`${label} Gift card sync failed (non-fatal):`, err);
  }

  try {
    // 2. Payments sync — last 3 days so we catch any late-arriving records.
    console.log(`${label} Step 2/4: Payments sync (last 3 days)`);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const paymentsResult = await syncService.syncPayments(threeDaysAgo);
    console.log(`${label} Payments: processed=${paymentsResult.processed} created=${paymentsResult.created} updated=${paymentsResult.updated} failed=${paymentsResult.failed}`);
  } catch (err) {
    console.error(`${label} Payments sync failed (non-fatal):`, err);
  }

  try {
    // 3. Orders sync — last 3 days.
    console.log(`${label} Step 3/4: Orders sync (last 3 days)`);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const ordersResult = await syncService.syncOrders(threeDaysAgo);
    console.log(`${label} Orders: processed=${ordersResult.processed} created=${ordersResult.created} updated=${ordersResult.updated} failed=${ordersResult.failed}`);
  } catch (err) {
    console.error(`${label} Orders sync failed (non-fatal):`, err);
  }

  try {
    // 4. Activation backfill — cross-checks activation amounts against the Activities
    //    API for any card that was added or slipped through during steps 1–3.
    console.log(`${label} Step 4/4: Activation amount backfill`);
    const backfillResult = await backfillGiftCardActivationAmounts();
    console.log(`${label} Backfill: filled=${backfillResult.updatedViaActivitiesApi} corrected=${backfillResult.correctedViaActivitiesApi} unresolved=${backfillResult.stillUnresolved}`);
  } catch (err) {
    console.error(`${label} Activation backfill failed (non-fatal):`, err);
  }

  console.log(`${label} Nightly sync complete.`);
}
