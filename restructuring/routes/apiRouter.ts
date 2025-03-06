/**
 * API Router
 * 
 * Defines the API routes for the application
 * Uses the service layer for business logic
 */
import { Router, Request, Response, NextFunction } from 'express';
import { OrderService } from '../services/orderService';
import { PaymentService } from '../services/paymentService';
import { GiftCardService } from '../services/giftCardService';
import { SyncService } from '../services/syncService';
import { DateRange } from '../schema';
import { getDateRangeBoundaries } from '../dateUtils';

export interface ErrorResponse {
  error: string;
  message: string;
  code?: string;
  details?: any;
}

// Helper function to convert errors to API responses
function toErrorResponse(error: Error): ErrorResponse {
  if (error.name === 'OrderError' || 
      error.name === 'PaymentError' || 
      error.name === 'GiftCardError' || 
      error.name === 'SyncError') {
    // Handle service-specific errors
    return {
      error: error.name,
      message: error.message,
      code: (error as any).code,
      details: (error as any).details
    };
  }
  
  // Handle generic errors
  return {
    error: error.name || 'UnknownError',
    message: error.message || 'An unexpected error occurred'
  };
}

// Helper function to extract date range parameters
function extractDateRange(req: Request): {
  dateRange: DateRange;
  startDate?: Date;
  endDate?: Date;
} {
  const dateRange = (req.query.dateRange as DateRange) || 'today';
  
  let startDate: Date | undefined;
  let endDate: Date | undefined;
  
  if (req.query.startDate && typeof req.query.startDate === 'string') {
    startDate = new Date(req.query.startDate);
  }
  
  if (req.query.endDate && typeof req.query.endDate === 'string') {
    endDate = new Date(req.query.endDate);
  }
  
  return { dateRange, startDate, endDate };
}

// Create API router
export function createApiRouter(
  orderService: OrderService,
  paymentService: PaymentService,
  giftCardService: GiftCardService,
  syncService: SyncService
): Router {
  const router = Router();
  
  // Logging middleware for API routes
  router.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
    });
    
    next();
  });
  
  // Error handling middleware
  router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('API Error:', err);
    
    const errorResponse = toErrorResponse(err);
    const status = err.name === 'NotFoundError' ? 404 : 500;
    
    res.status(status).json(errorResponse);
  });
  
  /**
   * Dashboard Summary API
   * GET /api/summary?dateRange=today&startDate=...&endDate=...
   */
  router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      
      console.log('Summary API - Using date range:', { dateRange, startDate, endDate });
      
      // Normalize the date range
      const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
      
      // Get summary data from services
      const [dailySummary, giftCardSummary] = await Promise.all([
        orderService.getOrderSummary(dateRange, start, end),
        giftCardService.getGiftCardSummary(dateRange, start, end)
      ]);
      
      // Combine the results
      const summary = {
        totalRevenue: dailySummary.totalRevenue,
        revenueChange: 0, // Will be calculated below
        totalOrders: dailySummary.totalOrders,
        ordersChange: 0, // Will be calculated below
        averageOrder: dailySummary.totalOrders > 0 
          ? dailySummary.totalRevenue / dailySummary.totalOrders 
          : 0,
        averageOrderChange: 0, // Will be calculated below
        giftCardSales: giftCardSummary.soldAmount,
        giftCardSalesChange: 0, // Will be calculated below
        totalItems: dailySummary.itemsSold,
        date: end.toISOString().split('T')[0]
      };
      
      // Get previous period data for comparison
      const currentPeriodDays = Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
      const previousStartDate = new Date(start.getTime() - (currentPeriodDays * 24 * 60 * 60 * 1000));
      const previousEndDate = new Date(start.getTime() - 1);
      
      const [previousSummary, previousGiftCardSummary] = await Promise.all([
        orderService.getOrderSummary(dateRange, previousStartDate, previousEndDate),
        giftCardService.getGiftCardSummary(dateRange, previousStartDate, previousEndDate)
      ]);
      
      // Calculate change percentages
      if (previousSummary.totalRevenue > 0) {
        summary.revenueChange = (dailySummary.totalRevenue - previousSummary.totalRevenue) / previousSummary.totalRevenue;
      } else {
        summary.revenueChange = dailySummary.totalRevenue > 0 ? 1 : 0;
      }
      
      if (previousSummary.totalOrders > 0) {
        summary.ordersChange = (dailySummary.totalOrders - previousSummary.totalOrders) / previousSummary.totalOrders;
      } else {
        summary.ordersChange = dailySummary.totalOrders > 0 ? 1 : 0;
      }
      
      const previousAverage = previousSummary.totalOrders > 0 
        ? previousSummary.totalRevenue / previousSummary.totalOrders 
        : 0;
        
      if (previousAverage > 0) {
        summary.averageOrderChange = (summary.averageOrder - previousAverage) / previousAverage;
      } else {
        summary.averageOrderChange = summary.averageOrder > 0 ? 1 : 0;
      }
      
      if (previousGiftCardSummary.soldAmount > 0) {
        summary.giftCardSalesChange = (giftCardSummary.soldAmount - previousGiftCardSummary.soldAmount) / previousGiftCardSummary.soldAmount;
      } else {
        summary.giftCardSalesChange = giftCardSummary.soldAmount > 0 ? 1 : 0;
      }
      
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Category Revenue API
   * GET /api/category-revenue?dateRange=today&startDate=...&endDate=...
   */
  router.get('/category-revenue', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      
      // Normalize the date range
      const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
      
      // Get category revenue from storage
      const categoryRevenue = await orderService.getCategoryRevenue(dateRange, start, end);
      
      res.json(categoryRevenue);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Hourly Revenue API
   * GET /api/hourly-revenue?dateRange=today&startDate=...&endDate=...
   */
  router.get('/hourly-revenue', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      
      // Normalize the date range
      const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
      
      // Get hourly revenue from storage
      const hourlyRevenue = await orderService.getHourlyRevenue(dateRange, start, end);
      
      res.json(hourlyRevenue);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Gift Card Summary API
   * GET /api/gift-card-summary?dateRange=today&startDate=...&endDate=...
   */
  router.get('/gift-card-summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      
      // Normalize the date range
      const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
      
      // Get gift card summary from service
      const giftCardSummary = await giftCardService.getGiftCardSummary(dateRange, start, end);
      
      res.json(giftCardSummary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Recent Transactions API
   * GET /api/transactions?dateRange=today&startDate=...&endDate=...&limit=10
   */
  router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const limit = parseInt(req.query.limit as string) || 10;
      
      // Normalize the date range
      const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
      
      // Get transactions from service
      const transactions = await paymentService.getPaymentsByDateRange(dateRange, start, end);
      
      // Limit results and return
      res.json(transactions.slice(0, limit));
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Detailed Transactions API
   * GET /api/detailed-transactions?dateRange=today&startDate=...&endDate=...
   */
  router.get('/detailed-transactions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      
      // Normalize the date range
      const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
      
      // Get transactions with more details
      const transactions = await paymentService.getPaymentsByDateRange(dateRange, start, end);
      
      // Add additional details for each transaction
      const detailedTransactions = await Promise.all(
        transactions.map(async (transaction) => {
          let orderDetails = null;
          
          if (transaction.orderId) {
            try {
              orderDetails = await orderService.getOrderWithDetails(transaction.orderId);
            } catch (orderError) {
              console.warn(`Could not fetch order details for transaction ${transaction.id}:`, orderError);
            }
          }
          
          return {
            ...transaction,
            order: orderDetails
          };
        })
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
  router.get('/sync-progress', async (req: Request, res: Response, next: NextFunction) => {
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
   * Body: { "type": "orders" | "payments" | "gift_cards" | "all", "startDate": "2023-01-01", "endDate": "2023-01-31" }
   */
  router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, startDate, endDate } = req.body;
      
      // Parse dates if provided
      const startDateObj = startDate ? new Date(startDate) : undefined;
      const endDateObj = endDate ? new Date(endDate) : undefined;
      
      // Start the sync process
      if (type === 'orders' || type === 'all') {
        syncService.syncOrders(startDateObj, endDateObj).catch(error => {
          console.error('Error syncing orders:', error);
        });
      }
      
      if (type === 'payments' || type === 'all') {
        syncService.syncPayments(startDateObj, endDateObj).catch(error => {
          console.error('Error syncing payments:', error);
        });
      }
      
      if (type === 'gift_cards' || type === 'all') {
        syncService.syncGiftCards().catch(error => {
          console.error('Error syncing gift cards:', error);
        });
      }
      
      res.json({
        success: true,
        message: `Sync started for ${type}`,
        startDate: startDateObj?.toISOString(),
        endDate: endDateObj?.toISOString()
      });
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Fix Gift Card Activation Amounts API
   * POST /api/fix-gift-cards
   */
  router.post('/fix-gift-cards', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Start the fix process asynchronously
      syncService.updateGiftCardActivationAmounts()
        .then(result => {
          console.log('Gift card fix completed:', result);
        })
        .catch(error => {
          console.error('Error fixing gift cards:', error);
        });
      
      res.json({
        success: true,
        message: 'Gift card activation amount fix process started'
      });
    } catch (error) {
      next(error);
    }
  });
  
  return router;
}