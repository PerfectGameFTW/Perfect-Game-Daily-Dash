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
        type: z.enum(['orders', 'payments', 'gift_cards', 'all', 'missing_payments']),
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
          result = await syncService.syncGiftCards();
          break;
        case 'missing_payments':
          // Special reconciliation tool for the March 6, 2025 architectural transition gap
          // This specifically addresses missing payment records since the transition began
          console.log('Starting special payment reconciliation tool for architectural transition gap');
          
          // Use the specific known timestamp when the transition occurred
          const transitionTimestamp = new Date('2025-03-06T04:13:41.000Z');
          
          // Allow overriding the start date but default to the transition time
          const reconciliationStart = startDate || transitionTimestamp;
          const reconciliationEnd = endDate || new Date();
          
          console.log(`Reconciliation period: ${reconciliationStart.toISOString()} to ${reconciliationEnd.toISOString()}`);
          
          // Execute the reconciliation
          result = await paymentService.syncMissingPayments(
            reconciliationStart,
            reconciliationEnd
          );
          
          // Log the results for monitoring
          console.log(`Payment reconciliation completed: ${result.succeeded} records synchronized, ${result.failed} failures`);
          break;
        case 'all':
          // Run all sync operations in parallel
          const [ordersResult, paymentsResult, giftCardsResult] = await Promise.all([
            syncService.syncOrders(startDate, endDate),
            syncService.syncPayments(startDate, endDate),
            syncService.syncGiftCards()
          ]);
          
          result = {
            orders: ordersResult,
            payments: paymentsResult,
            giftCards: giftCardsResult
          };
          break;
      }
      
      // Create a response message based on the sync type
      let message = 'Sync started successfully';
      if (validatedBody.type === 'missing_payments') {
        message = `Payment reconciliation completed successfully: ${result.succeeded} records synchronized, ${result.failed} failures`;
      }
      
      res.json({
        success: true,
        message,
        result
      });
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Fix Gift Card Activation Amounts API
   * POST /api/fix-gift-cards
   */
  router.post('/fix-gift-cards', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const fixedCount = await giftCardService.fixGiftCardActivationAmounts();
      
      res.json({
        success: true,
        message: 'Gift card activation amounts fixed successfully',
        fixedCount
      });
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}