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
   * Body: { type: "orders" | "payments" | "gift_cards" | "all", startDate?: string, endDate?: string }
   */
  router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const syncSchema = z.object({
        type: z.enum(['orders', 'payments', 'gift_cards', 'all']),
        startDate: z.string().optional(),
        endDate: z.string().optional()
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
      
      res.json({
        success: true,
        message: 'Sync started successfully',
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