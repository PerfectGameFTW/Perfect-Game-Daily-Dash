/**
 * API Routes
 * 
 * Defines all the API endpoints for the application using
 * the service layer for business logic.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboardService';
import { pgStorage } from '../pgStorage';
import { giftCardService } from '../services/giftCardService';
import { syncService } from '../services/syncService';
import { tryAcquireSyncLock, recordAuditStart, recordAuditFinish } from '../services/syncLocks';
import { paymentService } from '../services/paymentService';
import { DateRange, dateRangeSchema } from '../../shared/schema';
import { broadcast } from '../ws';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  syncLimiter,
  summaryLimiter,
  categoryRevenueLimiter,
  hourlyRevenueLimiter,
  giftCardSummaryLimiter,
  detailedTransactionsLimiter,
  syncProgressLimiter,
  syncStatusLimiter,
  analyzeGiftCardsLimiter,
  fixGiftCardsLimiter,
  fixGiftCardSingleLimiter,
  healthLimiter,
} from '../middleware/rateLimiter';
import { toSafeErrorResponse } from '../errors';
import { logger, errorContext } from '../logger';

/**
 * Router-level error middleware. Exported so that `server/routes.ts` can
 * attach it AFTER it has finished mounting its own backfill routes onto
 * the apiRouter — Express only invokes error middleware that was
 * registered after the route that called `next(err)`.
 */
export function attachApiErrorMiddleware(router: Router) {
  router.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('api.error', { path: req.path, method: req.method, ...errorContext(err) });
    if (!res.headersSent) {
      const { status, body } = toSafeErrorResponse(err);
      res.status(status).json(body);
    }
  });
}

export function createApiRouter(): Router {
  const router = Router();
  
  // Per-request access logs are emitted by the structured request logger
  // in server/index.ts (allow-listed fields only). Don't double-log here.

  // /health is reachable without auth (allow-listed below). Pin a tight
  // dedicated bucket so it can't be used as an unauthenticated firehose
  // for log noise or to drain the global apiLimiter budget that the rest
  // of /api shares.
  router.get('/health', healthLimiter, (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });


  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') {
      return next();
    }
    requireAuth(req, res, next);
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
        } catch {
          logger.warn('api.invalid_start_date');
        }
      }

      if (req.query.endDate && typeof req.query.endDate === 'string') {
        try {
          endDate = new Date(req.query.endDate);
        } catch {
          logger.warn('api.invalid_end_date');
        }
      }
    }
    
    return { dateRange, startDate, endDate };
  }
  
  // The router-level error middleware is attached at the bottom of
  // createApiRouter (see attachApiErrorMiddleware) so it can actually
  // catch next(err) from the routes registered below.
  
  /**
   * Dashboard Summary API
   * GET /api/summary
   */
  router.get('/summary', summaryLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const summary = await dashboardService.getDailySummary(dateRange, startDate, endDate);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Transactions API
   * GET /api/transactions
   * Returns completed transactions in the requested date range.
   */
  const transactionsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const txns = await pgStorage.getTransactions(dateRange, startDate, endDate, 'completed');
      res.json(txns);
    } catch (error) {
      next(error);
    }
  };
  router.get('/transactions', transactionsHandler);

  /**
   * Category Revenue API
   * GET /api/category-revenue
   * GET /api/revenue-by-category (legacy alias)
   */
  const categoryRevenueHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const categoryRevenue = await dashboardService.getCategoryRevenue(dateRange, startDate, endDate);
      res.json(categoryRevenue);
    } catch (error) {
      next(error);
    }
  };
  router.get('/category-revenue', categoryRevenueLimiter, categoryRevenueHandler);
  router.get('/revenue-by-category', categoryRevenueLimiter, categoryRevenueHandler);
  
  /**
   * Hourly Revenue API
   * GET /api/hourly-revenue
   */
  router.get('/hourly-revenue', hourlyRevenueLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
  router.get('/gift-card-summary', giftCardSummaryLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
  router.get('/detailed-transactions', detailedTransactionsLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
  router.get('/sync-progress', syncProgressLimiter, async (_req: Request, res: Response, next: NextFunction) => {
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
  router.post('/sync', requireAdmin, syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const syncSchema = z.object({
        type: z.enum(['orders', 'payments', 'gift_cards', 'gift_card_redemptions', 'refunds', 'catalog', 'all', 'missing_payments']),
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
          result = await syncService.syncGiftCardsHistoricalBackfill({
            actorUserId: (req as any).session?.userId ?? null,
            actorIp: req.ip ?? null,
          });
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
        case 'catalog':
          console.log('Starting catalog sync');
          const { syncCatalog: runCatalogSync } = await import('../services/catalogService');
          result = await runCatalogSync();
          const catalogResult = result as { categories: number; items: number; errors: string[] };
          console.log(`Catalog sync completed: ${catalogResult.categories} categories, ${catalogResult.items} items`);
          break;
        case 'missing_payments':
          console.log('Starting payment reconciliation sync');
          const reconciliationStart = startDate || new Date('2025-03-06T04:13:41.000Z');
          const reconciliationEnd = endDate || new Date();
          result = await syncService.syncPayments(reconciliationStart, reconciliationEnd);
          console.log(`Payment reconciliation completed: ${result.processed} processed, ${result.created} created`);
          break;
        case 'all':
          const actorCtx = {
            actorUserId: (req as any).session?.userId ?? null,
            actorIp: req.ip ?? null,
          };
          const [ordersResult, paymentsResult, giftCardsResult, redemptionsResult, refundsResult] = await Promise.all([
            syncService.syncOrders(startDate, endDate),
            syncService.syncPayments(startDate, endDate),
            syncService.syncGiftCardsHistoricalBackfill(actorCtx),
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
  router.post('/fix-gift-cards', requireAdmin, syncLimiter, fixGiftCardsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
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
  router.get('/analyze-gift-cards', analyzeGiftCardsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
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

  /**
   * Fix a single gift card's activation amount
   * POST /api/fix-gift-card/:id
   *
   * Operator-facing endpoint to retry the activation-amount link for one
   * specific gift card by internal ID. Re-homed here from the deleted
   * `server/api/giftCardFixer.ts` (the rest of that router was duplicate
   * dead code shadowed by the handlers above).
   */
  router.post('/fix-gift-card/:id', requireAdmin, fixGiftCardSingleLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const giftCardId = parseInt(req.params.id, 10);
      if (isNaN(giftCardId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid gift card ID',
          error: 'ID must be a number',
        });
      }

      const { fixNewGiftCardActivationAmount } = await import('../services/enhancedGiftCardFix');
      const result = await fixNewGiftCardActivationAmount(giftCardId);

      if (result.updated) {
        res.json({
          success: true,
          message: `Successfully fixed gift card #${giftCardId} with activation amount $${result.activationAmount}.`,
          source: result.source,
          result,
        });
      } else {
        res.json({
          success: false,
          message: `Could not fix gift card #${giftCardId}: ${result.error || 'Unknown error'}`,
          source: result.source,
          result,
        });
      }
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Sync Status API
   * GET /api/sync/status
   *
   * Returns the most recent sync timestamps for every sync type so the UI can
   * display a "last synced" indicator.
   */
  router.get('/sync/status', syncStatusLimiter, async (_req: Request, res: Response, next: NextFunction) => {
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
  router.post('/sync/historical', requireAdmin, syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
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

      // DB-level concurrency: a single shared advisory lock guards every
      // historical/backfill flow so concurrent admin triggers cannot
      // double-up on the shared Square API.
      const lock = await tryAcquireSyncLock('historical_sync');
      const actorCtx = {
        actorUserId: (req as any).session?.userId ?? null,
        actorIp: req.ip ?? null,
      };
      if (!lock) {
        const rejectedAuditId = await recordAuditStart({
          syncType: 'historical_sync',
          action: 'historical_sync',
          ...actorCtx,
          params: { startDate: startDate.toISOString(), rejectedReason: 'already_running' },
        });
        await recordAuditFinish(rejectedAuditId, {
          status: 'rejected',
          result: { reason: 'already_running' },
        });
        res.status(409).json({
          success: false,
          message: 'Historical sync is already running',
        });
        return;
      }

      let auditId: number;
      try {
        auditId = await recordAuditStart({
          syncType: 'historical_sync',
          action: 'historical_sync',
          ...actorCtx,
          params: { startDate: startDate.toISOString() },
        });
      } catch (err) {
        await lock.release();
        throw err;
      }

      res.status(202).json({
        success: true,
        message: `Historical sync started from ${startDate.toISOString().slice(0, 10)}. This runs in the background — check server logs for progress.`,
        startDate: startDate.toISOString(),
      });

      // Run in background — no await so the HTTP response is sent first.
      // The lock is released and the audit row finalised inside the
      // background promise so concurrent triggers see the lock as held
      // until the run actually completes.
      runHistoricalSync(startDate)
        .then(async () => {
          await recordAuditFinish(auditId, { status: 'completed' });
        })
        .catch(async (err) => {
          console.error('[HistoricalSync] Unhandled error:', err);
          await recordAuditFinish(auditId, {
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(async () => {
          await lock.release();
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
  async function handleGiftCardFullSync(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await syncService.syncGiftCardsHistoricalBackfill({
        actorUserId: (req as any).session?.userId ?? null,
        actorIp: req.ip ?? null,
      });
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

  router.post('/sync/gift-cards/full', requireAdmin, syncLimiter, handleGiftCardFullSync);
  router.post('/sync/gift-cards-backfill', requireAdmin, syncLimiter, handleGiftCardFullSync);

  router.post('/sync/gift-cards/refresh-balances', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await giftCardService.refreshAllGiftCardBalances();
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('[API] Gift card balance refresh error:', error);
      next(error);
    }
  });

  router.post('/sync/quick', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { runFrequentSync } = await import('../services/schedulerService');
      await runFrequentSync();
      res.json({ success: true, message: 'Quick sync completed' });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sync/catalog', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { syncCatalog } = await import('../services/catalogService');
      const result = await syncCatalog();
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('[API] Catalog sync error:', error);
      next(error);
    }
  });

  router.post('/sync/catalog/backfill', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { syncCatalog, backfillCategories } = await import('../services/catalogService');
      const catalogResult = await syncCatalog();
      console.log(`Catalog synced: ${catalogResult.categories} categories, ${catalogResult.items} items`);
      const backfillResult = await backfillCategories();
      res.json({
        success: true,
        catalog: catalogResult,
        backfill: backfillResult,
      });
    } catch (error) {
      console.error('[API] Catalog backfill error:', error);
      next(error);
    }
  });

  // Admin: read/update the in-process Square 429 alerter thresholds.
  // GET returns the currently effective tunable config (env defaults
  // merged with any persisted override). PUT validates, persists to
  // app_settings, and pushes the new values into the live alerter so
  // the change applies without a server restart.
  router.get(
    '/admin/alerts/square-rate-limit',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const { squareRateLimitAlerter } = await import(
          '../services/squareRateLimitAlert'
        );
        const tunable = squareRateLimitAlerter.getTunable();
        const effective = squareRateLimitAlerter.getEffectiveConfig();
        res.json({
          ...tunable,
          // `webhookConfigured` lets the UI tell admins whether a
          // webhook is wired up at all without leaking the URL itself.
          webhookConfigured: effective.webhookUrl !== null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/admin/alerts/square-rate-limit',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { squareRateLimitAlertSettingsSchema } = await import(
          '@shared/schema'
        );
        const parsed = squareRateLimitAlertSettingsSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'Invalid alert settings',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const { applyAndPersistSquareRateLimitAlertOverride } = await import(
          '../services/squareRateLimitAlertSettings'
        );
        await applyAndPersistSquareRateLimitAlertOverride(parsed.data);
        const { squareRateLimitAlerter } = await import(
          '../services/squareRateLimitAlert'
        );
        const effective = squareRateLimitAlerter.getEffectiveConfig();
        res.json({
          ...squareRateLimitAlerter.getTunable(),
          webhookConfigured: effective.webhookUrl !== null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: paginated browser for the MCP read-query audit log. Backed by
  // pgStorage.listMcpQueryAudit; supports filtering by admin username
  // substring, success/error outcome, and date range.
  router.get(
    '/admin/mcp-audit',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const querySchema = z.object({
          adminUsername: z.string().trim().max(100).optional(),
          outcome: z.enum(['success', 'error']).optional(),
          startDate: z.string().datetime().optional(),
          endDate: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        });
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'Invalid query parameters',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const { adminUsername, outcome, startDate, endDate, limit, offset } = parsed.data;
        const page = await pgStorage.listMcpQueryAudit({
          adminUsername,
          outcome,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
          limit,
          offset,
        });
        res.json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // NOTE: do NOT attach the error middleware here — `server/routes.ts`
  // adds more routes to this router AFTER createApiRouter() returns,
  // and Express won't dispatch an error middleware to a route that was
  // registered after it. routes.ts calls attachApiErrorMiddleware once
  // every route has been mounted.
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
    // Nested call: parent runHistoricalSync already holds the shared
    // historical advisory lock, so skip the lock here to avoid self-deadlock.
    const gcResult = await syncService.syncGiftCardsHistoricalBackfill({ skipLock: true });
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