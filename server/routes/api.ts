/**
 * API Routes
 * 
 * Defines all the API endpoints for the application using
 * the service layer for business logic.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboardService';
import { giftCardService } from '../services/giftCardService';
import { syncService } from '../services/syncService';
import { paymentService } from '../services/paymentService';
import { DateRange, dateRangeSchema } from '../../shared/schema';
import { giftCardFixerRouter } from '../api/giftCardFixer';
import { broadcast } from '../ws';

export function createApiRouter(): Router {
  const router = Router();
  
  // Request logging middleware
  router.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} [${req.method}] ${req.url}`);
    next();
  });
  
  /**
   * Extract date range parameters from the request
   */
  function extractDateRange(req: Request): {
    dateRange: DateRange;
    startDate?: Date;
    endDate?: Date;
  } {
    // Parse date range type
    const dateRangeParam = req.query.dateRange as string;
    let dateRange: DateRange;
    
    try {
      dateRange = dateRangeSchema.parse(dateRangeParam);
    } catch (error) {
      dateRange = 'today';
    }
    
    // For custom date ranges, parse start and end dates
    let startDate: Date | undefined;
    let endDate: Date | undefined;
    
    if (dateRange === 'custom') {
      if (req.query.startDate && typeof req.query.startDate === 'string') {
        try {
          startDate = new Date(req.query.startDate);
          
          // Log parsed dates
          console.log(`Hourly Revenue API - Parsing dates: {
  startDateStr: '${req.query.startDate}',
  endDateStr: '${req.query.endDate}'
}`);
        } catch (error) {
          console.error('Invalid start date:', req.query.startDate);
        }
      }
      
      if (req.query.endDate && typeof req.query.endDate === 'string') {
        try {
          endDate = new Date(req.query.endDate);
        } catch (error) {
          console.error('Invalid end date:', req.query.endDate);
        }
      }
      
      console.log(`Hourly Revenue API - Parsed dates: {
  startDate: '${startDate?.toISOString() || 'undefined'}',
  endDate: '${endDate?.toISOString() || 'undefined'}'
}`);
    }
    
    return { dateRange, startDate, endDate };
  }
  
  /**
   * API error handler middleware
   */
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('API Error:', err);
    
    const statusCode = err.name.includes('NotFound') ? 404 :
                       err.name.includes('Invalid') ? 400 : 500;
    
    res.status(statusCode).json({
      error: err.name,
      message: err.message
    });
  });
  
  /**
   * Dashboard Summary API
   * GET /api/summary
   */
  router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      
      console.log(`Summary API - Using predefined date range: { dateRange: '${dateRange}' }`);
      
      if (dateRange === 'today') {
        console.log('🔍 SERVER: Processing TODAY request with no custom dates');
      } else if (dateRange === 'yesterday') {
        console.log('🔍 SERVER: Processing YESTERDAY request with no custom dates');
      } else if (dateRange === 'custom') {
        console.log(`🔍 SERVER: Processing CUSTOM request with dates: ${startDate} to ${endDate}`);
      }
      
      const summary = await dashboardService.getDailySummary(dateRange, startDate, endDate);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Category Revenue API
   * GET /api/category-revenue
   */
  router.get('/category-revenue', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const categoryRevenue = await dashboardService.getCategoryRevenue(dateRange, startDate, endDate);
      res.json(categoryRevenue);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Hourly Revenue API
   * GET /api/hourly-revenue
   */
  router.get('/hourly-revenue', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const hourlyRevenue = await dashboardService.getHourlyRevenue(dateRange, startDate, endDate);
      res.json(hourlyRevenue);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Gift Card Summary API
   * GET /api/gift-card-summary
   */
  router.get('/gift-card-summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const giftCardSummary = await dashboardService.getGiftCardSummary(dateRange, startDate, endDate);
      res.json(giftCardSummary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Detailed Transactions API
   * GET /api/detailed-transactions
   */
  router.get('/detailed-transactions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const detailedTransactions = await dashboardService.getDetailedTransactionBreakdown(
        dateRange, 
        startDate, 
        endDate
      );
      res.json(detailedTransactions);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Sync Progress API
   * GET /api/sync-progress
   */
  router.get('/sync-progress', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const progress = await syncService.getSyncProgress();
      res.json(progress);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Start Sync API
   * POST /api/sync
   * 
   * Used to trigger various synchronization operations including the special
   * reconciliation tool for missing payments from the March 6, 2025 gap.
   * 
   * Body: { 
   *   type: "orders" | "payments" | "gift_cards" | "all" | "missing_payments", 
   *   startDate?: string,  // Optional ISO date string, defaults to March 6, 2025 04:13:41 UTC for missing_payments
   *   endDate?: string     // Optional ISO date string, defaults to current time
   * }
   * 
   * The "missing_payments" type specifically addresses the architectural transition gap
   * where payments records were missing since March 6, 2025. This is part of our
   * dual-track strategy for maintaining data consistency during the transition.
   */
  router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const syncSchema = z.object({
        type: z.enum(['orders', 'payments', 'gift_cards', 'gift_card_redemptions', 'refunds', 'all', 'missing_payments']),
        startDate: z.string().optional()
          .refine(date => !date || !isNaN(new Date(date).getTime()), {
            message: "startDate must be a valid date string"
          }),
        endDate: z.string().optional()
          .refine(date => !date || !isNaN(new Date(date).getTime()), {
            message: "endDate must be a valid date string"
          })
      });
      
      const validatedBody = syncSchema.parse(req.body);
      
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (validatedBody.startDate) {
        startDate = new Date(validatedBody.startDate);
      }
      
      if (validatedBody.endDate) {
        endDate = new Date(validatedBody.endDate);
      }
      
      let result;
      
      switch (validatedBody.type) {
        case 'orders':
          result = await syncService.syncOrders(startDate, endDate);
          break;
        case 'payments':
          result = await syncService.syncPayments(startDate, endDate);
          break;
        case 'gift_cards':
          // Route to the canonical Activities-API-based full reconciliation
          // (resumable, cursor-checkpointed) instead of the legacy listGiftCards path
          result = await syncService.syncGiftCardsHistoricalBackfill();
          break;
        case 'gift_card_redemptions':
          console.log('Starting gift card redemption synchronization');
          result = await syncService.syncGiftCardRedemptions(startDate, endDate);
          console.log(`Gift card redemption sync completed: ${result.processed} processed, ${result.created} created, ${result.errors.length} errors`);
          break;
        case 'refunds':
          console.log('Starting refund synchronization');
          result = await syncService.syncRefunds(startDate, endDate);
          console.log(`Refund sync completed: ${result.processed} processed, ${result.created} created, ${result.updated} updated, ${result.failed} failed`);
          break;
        case 'missing_payments':
          console.log('Starting payment reconciliation sync');
          const reconciliationStart = startDate || new Date('2025-03-06T04:13:41.000Z');
          const reconciliationEnd = endDate || new Date();
          result = await syncService.syncPayments(reconciliationStart, reconciliationEnd);
          console.log(`Payment reconciliation completed: ${result.processed} processed, ${result.created} created`);
          break;
        case 'all':
          const [ordersResult, paymentsResult, giftCardsResult, redemptionsResult, refundsResult] = await Promise.all([
            syncService.syncOrders(startDate, endDate),
            syncService.syncPayments(startDate, endDate),
            syncService.syncGiftCardsHistoricalBackfill(),
            syncService.syncGiftCardRedemptions(startDate, endDate),
            syncService.syncRefunds(startDate, endDate)
          ]);
          
          result = {
            orders: ordersResult,
            payments: paymentsResult,
            giftCards: giftCardsResult,
            giftCardRedemptions: redemptionsResult,
            refunds: refundsResult
          };
          break;
      }
      
      // Create a response message based on the sync type and result format
      let message = 'Sync started successfully';
      
      // Handle different result formats based on sync type
      if (result) {
        if (validatedBody.type === 'missing_payments' && 'processed' in result && 'created' in result) {
          message = `Payment reconciliation completed: ${result.processed} processed, ${result.created} created`;
        } else if (validatedBody.type === 'gift_card_redemptions' && 'matched' in result) {
          message = `Gift card redemption sync completed successfully: ${result.processed} processed, ${result.matched} matched, ${result.created} created, ${result.errors.length} errors`;
        } else if ('processed' in result) {
          if ('success' in result && result.success !== undefined) {
            // Gift card redemption result format
            message = `Sync completed: ${result.processed} processed, ${result.created} created`;
          } else {
            // Standard sync result format for orders, payments, gift cards
            const updated = 'updated' in result ? result.updated : 0;
            const failed = 'failed' in result ? result.failed : 0;
            message = `Sync completed: ${result.processed} processed, ${result.created} created, ${updated} updated, ${failed} failed`;
          }
        } else if ('orders' in result) {
          message = 'All sync operations completed';
        }
      }
      
      res.json({
        success: true,
        message,
        result
      });

      broadcast('data-updated', { syncType: validatedBody.type });
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Fix ALL Gift Card Activation Amounts API
   * POST /api/fix-gift-cards
   * 
   * This endpoint provides a comprehensive solution to the gift card activation amount issue for ALL cards,
   * by properly linking gift cards to their original orders and extracting accurate activation amounts.
   * 
   * Enhanced Implementation:
   * 1. Direct Square API integration for both cards and order data
   * 2. Multi-stage matching strategy with expanded timeframes:
   *    a. Square Order ID direct matching when available
   *    b. GAN (gift card number) matching with orders
   *    c. Temporal matching (order within 30 minutes of gift card creation)
   *    d. Line item name + amount matching
   * 3. Permanent linking of gift cards to their activation orders
   * 4. Future-proofing through automatic linking during creation
   * 
   * Critical Fix:
   * - Works for ALL cards in the system, not just recent ones
   * - Always uses basePriceMoney for accurate activation amounts on discounted cards
   * - Creates permanent order links for future reference
   * 
   * Returns detailed results of the operation including counts and individual card fixes.
   */
  router.post('/fix-gift-cards', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Use the Activities-API-first backfill (preferred) with order-matching fallback
      const { backfillGiftCardActivationAmounts } = await import('../services/enhancedGiftCardFix');
      
      const result = await backfillGiftCardActivationAmounts();
      
      res.json({
        success: true,
        message: `Backfill complete: ${result.updatedViaActivitiesApi} via Activities API, ${result.updatedViaOrderMatch} via order matching, ${result.stillUnresolved} unresolved`,
        result
      });
    } catch (error) {
      console.error('Error backfilling gift card activation amounts:', error);
      next(error);
    }
  });
  
  /**
   * Analyze Gift Card Activation Amounts & Linking API
   * GET /api/analyze-gift-cards
   * 
   * This endpoint provides comprehensive analysis of gift card activation amounts
   * and their linking to original orders, including detailed statistics for monitoring
   * the health of the gift card system.
   */
  router.get('/analyze-gift-cards', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Import the enhanced gift card analysis service
      const { analyzeGiftCardLinkingStatus } = await import('../services/enhancedGiftCardFix');
      
      // Run the enhanced analysis
      const analysis = await analyzeGiftCardLinkingStatus();
      
      res.json({
        success: true,
        message: `Analysis complete: ${analysis.withOrderLink} of ${analysis.totalGiftCards} gift cards linked to orders`,
        analysis
      });
    } catch (error) {
      console.error('Error analyzing gift card linking status:', error);
      next(error);
    }
  });
  
  // Use gift card fixer router for dedicated API endpoints
  router.use(giftCardFixerRouter);

  /**
   * Sync Status API
   * GET /api/sync/status
   *
   * Returns the most recent sync timestamps for every sync type so the UI can
   * display a "last synced" indicator.
   */
  router.get('/sync/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = await import('../db');
      const { syncState } = await import('../../shared/schema');
      const { desc } = await import('drizzle-orm');

      const rows = await db
        .select()
        .from(syncState)
        .orderBy(desc(syncState.lastSyncedAt));

      // Collapse to one row per syncType (most recent)
      const byType: Record<string, { lastSyncedAt: Date | null; status: string; processedCount: number | null }> = {};
      for (const row of rows) {
        if (!byType[row.syncType]) {
          byType[row.syncType] = {
            lastSyncedAt: row.lastSyncedAt,
            status: row.status ?? '',
            processedCount: row.processedCount,
          };
        }
      }

      // Overall "last synced" = most recent completed sync across all types
      const completedSyncs = rows.filter(r => r.status === 'completed' && r.lastSyncedAt);
      const overallLastSynced = completedSyncs.length > 0
        ? completedSyncs.reduce((latest, r) =>
            r.lastSyncedAt! > latest ? r.lastSyncedAt! : latest,
            completedSyncs[0].lastSyncedAt!
          )
        : null;

      res.json({ success: true, byType, overallLastSynced });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Historical Catch-up Sync API
   * POST /api/sync/historical
   *
   * Kicks off a background process that loops through monthly date chunks from
   * startDate (default: 2 years ago) through today, calling syncOrders and
   * syncPayments for each chunk.  Also runs a full gift card sync and activation
   * backfill at the end.
   *
   * Returns 202 immediately so the HTTP request never times out.
   */
  router.post('/sync/historical', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      let startDate = twoYearsAgo;
      if (req.body?.startDate) {
        const parsed = new Date(req.body.startDate);
        if (!isNaN(parsed.getTime())) {
          startDate = parsed;
        }
      }

      res.status(202).json({
        success: true,
        message: `Historical sync started from ${startDate.toISOString().slice(0, 10)}. This runs in the background — check server logs for progress.`,
        startDate: startDate.toISOString(),
      });

      // Run in background — no await so the HTTP response is sent first
      runHistoricalSync(startDate).catch(err => {
        console.error('[HistoricalSync] Unhandled error:', err);
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Resumable Gift Card Full Reconciliation (canonical path)
   * POST /api/sync/gift-cards/full   — spec-required name
   * POST /api/sync/gift-cards-backfill — legacy alias kept for backwards compat
   *
   * Pages through ALL Square ACTIVATE events (oldest first) via the Activities API,
   * upserting each gift card with the correct UTC purchase_date and activation amount.
   * Saves a cursor checkpoint after every page so the job resumes from where it left
   * off if the server restarts mid-scan — fixing the March 9-20 data gap.
   *
   * Call repeatedly (each call processes up to 20 pages / 1,000 events) until the
   * response shows `finished: true`.
   */
  async function handleGiftCardFullSync(_req: Request, res: Response, next: NextFunction) {
    try {
      const result = await syncService.syncGiftCardsHistoricalBackfill();
      res.json({
        success: true,
        message: result.finished
          ? `Full sync complete! processed=${result.processed} created=${result.created} updated=${result.updated} failed=${result.failed} pages=${result.pagesProcessed}`
          : `Full sync in progress — call again to continue. processed=${result.processed} created=${result.created} updated=${result.updated} failed=${result.failed} pages=${result.pagesProcessed}`,
        result,
      });
    } catch (error) {
      console.error('[API] Gift card full sync error:', error);
      next(error);
    }
  }

  router.post('/sync/gift-cards/full', handleGiftCardFullSync);
  router.post('/sync/gift-cards-backfill', handleGiftCardFullSync);

  router.post('/sync/quick', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { runFrequentSync } = await import('../services/schedulerService');
      await runFrequentSync();
      res.json({ success: true, message: 'Quick sync completed' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Background historical sync worker.
 * Processes one month at a time to avoid API rate limits and memory pressure.
 */
async function runHistoricalSync(startDate: Date): Promise<void> {
  const { backfillGiftCardActivationAmounts } = await import('../services/enhancedGiftCardFix');

  const label = `[HistoricalSync ${new Date().toISOString()}]`;
  console.log(`${label} Starting from ${startDate.toISOString().slice(0, 10)}`);

  const now = new Date();
  let chunkStart = new Date(startDate);
  let chunkIndex = 0;

  while (chunkStart < now) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    if (chunkEnd > now) chunkEnd.setTime(now.getTime());

    const label2 = `${label} [chunk ${++chunkIndex} ${chunkStart.toISOString().slice(0, 10)}→${chunkEnd.toISOString().slice(0, 10)}]`;
    console.log(`${label2} Syncing orders...`);

    try {
      const ordersResult = await syncService.syncOrders(chunkStart, chunkEnd);
      console.log(`${label2} Orders: processed=${ordersResult.processed} created=${ordersResult.created}`);
    } catch (err) {
      console.error(`${label2} Orders sync error (continuing):`, err);
    }

    try {
      const paymentsResult = await syncService.syncPayments(chunkStart, chunkEnd);
      console.log(`${label2} Payments: processed=${paymentsResult.processed} created=${paymentsResult.created}`);
    } catch (err) {
      console.error(`${label2} Payments sync error (continuing):`, err);
    }

    try {
      const refundsResult = await syncService.syncRefunds(chunkStart, chunkEnd);
      console.log(`${label2} Refunds: processed=${refundsResult.processed} created=${refundsResult.created}`);
    } catch (err) {
      console.error(`${label2} Refunds sync error (continuing):`, err);
    }

    chunkStart = new Date(chunkEnd);
    // Small pause between chunks to be kind to the Square API rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // After all date chunks, run the resumable Activities-API gift card reconciliation.
  // This replaces the old syncGiftCards() (listGiftCards — no date filter, arbitrary order,
  // loses progress on restart).  The new method pages through ALL ACTIVATE events ASC,
  // checkpointing after each page so restarts resume mid-scan.
  console.log(`${label} Syncing all gift cards via Activities API (resumable)...`);
  try {
    const gcResult = await syncService.syncGiftCardsHistoricalBackfill();
    console.log(`${label} Gift cards: processed=${gcResult.processed} created=${gcResult.created} updated=${gcResult.updated} failed=${gcResult.failed} pages=${gcResult.pagesProcessed} finished=${gcResult.finished}`);
  } catch (err) {
    console.error(`${label} Gift card sync error:`, err);
  }

  console.log(`${label} Running activation backfill...`);
  try {
    const backfillResult = await backfillGiftCardActivationAmounts();
    console.log(`${label} Backfill: filled=${backfillResult.updatedViaActivitiesApi} corrected=${backfillResult.correctedViaActivitiesApi} unresolved=${backfillResult.stillUnresolved}`);
  } catch (err) {
    console.error(`${label} Backfill error:`, err);
  }

  console.log(`${label} Historical sync complete across ${chunkIndex} monthly chunks.`);

  broadcast('data-updated', { syncType: 'historical' });
}