declare global {
  interface BigInt {
    toJSON(): string;
  }
}

if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { db } from "./db"; // Import db directly
import { pgStorage } from "./pgStorage"; // Keep this for other storage operations
import { paymentService } from "./services/paymentService"; // Import for hourly revenue timezone fix
import {
  dateRangeSchema,
  transactions,
  giftCards,
  giftCardRedemptions,
  syncState,
  orders,
  orderLineItems,
  orderModifiers,
  orderDiscounts,
  type InsertSyncState
} from "@shared/schema";
import { parse } from "date-fns";
import * as squareClient from "./squareClient";
const squareSDK = squareClient.squareClient;
import { and, gte, lte, sql, eq, gt, or, desc, count } from "drizzle-orm";
import { syncService } from "./services/syncService";
import { dashboardService } from "./services/dashboardService";
import { getEasternDateRange } from "./dateUtils";
import { requireAuth, requireAdmin } from "./middleware/auth";
// Helper function to safely process Square API response data
function processSafeSquareData(data: any): any {
  try {
    // First convert BigInts to strings
    const stringified = JSON.stringify(data, (key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });

    // Then parse back to ensure we have a clean object
    return JSON.parse(stringified);
  } catch (error) {
    console.error('Error processing Square data:', error);
    // Return a safe version of the data
    return {
      id: data.id || 'unknown',
      error: 'Failed to process data'
    };
  }
}

// Helper function to ensure data is safe for JSON serialization
function ensureSerializable(data: any): any {
  try {
    const converted = JSON.parse(JSON.stringify(data, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));
    return converted;
  } catch (error) {
    console.error('Error making data serializable:', error);
    return {
      id: data.id,
      error: 'Data contained non-serializable values'
    };
  }
}

//Helper function to create consistent error responses.  Add this function definition
function toErrorResponse(error: any): { error: string; details?: string } {
  return {
    error: error instanceof Error ? error.message : 'Unknown error',
    details: error.stack,
  };
}

//Helper function to handle Order related errors. Add this function definition
class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

class OrderNotFoundError extends OrderError {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}


// Import the router creators
import { createApiRouter } from './routes/api';
import { createAuthRouter } from './routes/auth';
import { initWebSocket } from './ws';

export async function registerRoutes(app: Express): Promise<Server> {
  // Create the routers using our service-based implementation
  const apiRouter = createApiRouter();
  const authRouter = createAuthRouter();
  
  // Legacy API routes below will be gradually migrated to the new service-based implementation

  // Get dashboard summary data
  apiRouter.get("/summary", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided, regardless of named range
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          // Log incoming date strings for debugging
          console.log('Summary API - Parsing dates:', {
            startDateStr: req.query.startDate,
            endDateStr: req.query.endDate,
            dateRange: dateRange
          });

          // Handle different date formats (ISO string or simple date)
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          if (startDateStr.includes('T')) {
            // It's an ISO string
            startDate = new Date(startDateStr);
          } else {
            // It's a simple date
            startDate = parse(startDateStr, "yyyy-MM-dd", new Date());
          }

          if (endDateStr.includes('T')) {
            // It's an ISO string
            endDate = new Date(endDateStr);
          } else {
            // It's a simple date
            endDate = parse(endDateStr, "yyyy-MM-dd", new Date());
          }

          console.log('Summary API - Parsed dates:', {
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString(),
            dateRange: dateRange
          });
        } catch (err) {
          console.error('Error parsing dates:', err);
        }
      } else {
        // Log when we're using a predefined date range with no custom dates
        console.log('Summary API - Using predefined date range:', {
          dateRange: dateRange
        });

        if (dateRange === 'yesterday') {
          console.log('🔍 SERVER: Processing YESTERDAY request with no custom dates');
        }
      }

      const summary = await dashboardService.getDailySummary(parsedDateRange.data, startDate, endDate);

      res.json(summary);
    } catch (error) {
      console.error("Error getting summary:", error);
      res.status(500).json({ error: "Server error while getting summary data" });
    }
  });

  // Get transactions with date range filter
  apiRouter.get("/transactions", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided, regardless of named range
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          // Handle different date formats (ISO string or simple date)
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          if (startDateStr.includes('T')) {
            // It's an ISO string
            startDate = new Date(startDateStr);
          } else {
            // It's a simple date
            startDate = parse(startDateStr, "yyyy-MM-dd", new Date());
          }

          if (endDateStr.includes('T')) {
            // It's an ISO string
            endDate = new Date(endDateStr);
          } else {
            // It's a simple date
            endDate = parse(endDateStr, "yyyy-MM-dd", new Date());
          }
        } catch (err) {
          console.error('Error parsing transaction dates:', err);
        }
      }

      // Get only completed transactions by default
      const transactions = await pgStorage.getTransactions(parsedDateRange.data, startDate, endDate, 'completed');

      res.json(transactions);
    } catch (error) {
      console.error("Error getting transactions:", error);
      res.status(500).json({ error: "Server error while getting transactions data" });
    }
  });

  // Get revenue by category
  apiRouter.get("/revenue-by-category", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided, regardless of named range
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          // Handle different date formats (ISO string or simple date)
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          if (startDateStr.includes('T')) {
            // It's an ISO string
            startDate = new Date(startDateStr);
          } else {
            // It's a simple date
            startDate = parse(startDateStr, "yyyy-MM-dd", new Date());
          }

          if (endDateStr.includes('T')) {
            // It's an ISO string
            endDate = new Date(endDateStr);
          } else {
            // It's a simple date
            endDate = parse(endDateStr, "yyyy-MM-dd", new Date());
          }
        } catch (err) {
          console.error('Error parsing category revenue dates:', err);
        }
      }

      const categoryRevenue = await pgStorage.getCategoryRevenue(parsedDateRange.data, startDate, endDate);

      res.json(categoryRevenue);
    } catch (error) {
      console.error("Error getting category revenue:", error);
      res.status(500).json({ error: "Server error while getting category revenue data" });
    }
  });

  // Get hourly revenue
  apiRouter.get("/hourly-revenue", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided, regardless of named range
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          // Log incoming date strings for debugging
          console.log('Hourly Revenue API - Parsing dates:', {
            startDateStr: req.query.startDate,
            endDateStr: req.query.endDate
          });

          // Handle different date formats (ISO string or simple date)
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          if (startDateStr.includes('T')) {
            // It's an ISO string
            startDate = new Date(startDateStr);
          } else {
            // It's a simple date
            startDate = parse(startDateStr, "yyyy-MM-dd", new Date());
          }

          if (endDateStr.includes('T')) {
            // It's an ISO string
            endDate = new Date(endDateStr);
          } else {
            // It's a simple date
            endDate = parse(endDateStr, "yyyy-MM-dd", new Date());
          }

          console.log('Hourly Revenue API - Parsed dates:', {
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString()
          });
        } catch (err) {
          console.error('Error parsing hourly revenue dates:', err);
        }
      }

      // Use paymentService instead of pgStorage for hourly revenue
      const hourlyRevenue = await paymentService.getHourlyRevenue(parsedDateRange.data, startDate, endDate);
      
      console.log(`Found ${hourlyRevenue.length} hourly revenue entries from payment service`);

      // Return the direct hourly revenue without additional processing
      res.json(hourlyRevenue);
    } catch (error) {
      console.error("Error getting hourly revenue:", error);
      res.status(500).json({ error: "Server error while getting hourly revenue data" });
    }
  });

  // Get gift card summary
  apiRouter.get("/gift-card-summary", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided, regardless of named range
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          // Log incoming date strings for debugging
          console.log('Gift Card Summary API - Parsing dates:', {
            startDateStr: req.query.startDate,
            endDateStr: req.query.endDate
          });

          // Handle different date formats (ISO string or simple date)
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          if (startDateStr.includes('T')) {
            // It's an ISO string
            startDate = new Date(startDateStr);
          } else {
            // It's a simple date
            startDate = parse(startDateStr, "yyyy-MM-dd", new Date());
          }

          if (endDateStr.includes('T')) {
            // It's an ISO string
            endDate = new Date(endDateStr);
          } else {
            // It's a simple date
            endDate = parse(endDateStr, "yyyy-MM-dd", new Date());
          }

          console.log('Gift Card Summary API - Parsed dates:', {
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString()
          });
        } catch (err) {
          console.error('Error parsing gift card summary dates:', err);
        }
      }

      const giftCardSummary = await pgStorage.getGiftCardSummary(parsedDateRange.data, startDate, endDate);

      res.json(giftCardSummary);
    } catch (error) {
      console.error("Error getting gift card summary:", error);
      res.status(500).json({ error: "Server error while getting gift card summary data" });
    }
  });

  // Get detailed transaction breakdown
  apiRouter.get("/detailed-transactions", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided, regardless of named range
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          // Log incoming date strings for debugging
          console.log('Detailed Transactions API - Parsing dates:', {
            startDateStr: req.query.startDate,
            endDateStr: req.query.endDate
          });

          // Handle different date formats (ISO string or simple date)
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          if (startDateStr.includes('T')) {
            // It's an ISO string
            startDate = new Date(startDateStr);
          } else {
            // It's a simple date
            startDate = parse(startDateStr, "yyyy-MM-dd", new Date());
          }

          if (endDateStr.includes('T')) {
            // It's an ISO string
            endDate = new Date(endDateStr);
          } else {
            // It's a simple date
            endDate = parse(endDateStr, "yyyy-MM-dd", new Date());
          }

          console.log('Detailed Transactions API - Parsed dates:', {
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString()
          });
        } catch (err) {
          console.error('Error parsing detailed transactions dates:', err);
        }
      }

      // Delegate entirely to dashboardService which correctly computes all buckets
      const detailedBreakdown = await dashboardService.getDetailedTransactionBreakdown(
        parsedDateRange.data,
        startDate,
        endDate
      );

      res.json(detailedBreakdown);
    } catch (error) {
      console.error("Error getting detailed transaction breakdown:", error);
      res.status(500).json({ error: "Server error while getting detailed transaction data" });
    }
  });


  

  // Add diagnostic endpoint for Square API connection
  apiRouter.get("/test-square-connection", async (req, res) => {
    try {
      console.log("Testing Square API connection...");
      const result = await squareClient.testConnection();
      console.log("Square API connection test result:", result);
      res.json(result);
    } catch (error) {
      console.error("Square API connection test failed:", error);
      res.status(500).json({
        success: false,
        error: "Failed to connect to Square API",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });
  
  // Test Orders API directly (debugging endpoint)
  apiRouter.get("/test-orders-api", async (req, res) => {
    try {
      console.log("Testing Square Orders API directly...");
      
      // Get the location ID from environment
      const locationId = process.env.SQUARE_LOCATION_ID;
      if (!locationId) {
        return res.status(500).json({
          success: false, 
          message: "Square location ID is not configured"
        });
      }
      
      // Create a simpler search request
      const searchRequest = {
        locationIds: [locationId],
        query: {
          filter: {
            stateFilter: {
              states: ['COMPLETED' as const]
            }
          },
          sort: {
            sortField: 'CREATED_AT' as const,
            sortOrder: 'DESC' as const
          }
        },
        limit: 3
      };
      
      console.log("Sending Orders search request:", JSON.stringify(searchRequest, null, 2));
      
      // Make the API call directly
      const response = await squareSDK.orders.search(searchRequest);
      
      const orderCount = response.orders?.length || 0;
      console.log(`Found ${orderCount} orders in test call`);
      
      const safeResponse = {
        success: true,
        orderCount: orderCount,
        hasOrders: orderCount > 0,
        sampleData: orderCount > 0 ? {
          orderId: response.orders?.[0].id,
          state: response.orders?.[0].state,
          createdAt: response.orders?.[0].createdAt,
          lineItemCount: response.orders?.[0].lineItems?.length || 0
        } : null
      };
      
      res.json(safeResponse);
    } catch (error) {
      console.error("Error testing Square Orders API:", error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
        errorDetails: error instanceof Error ? error.stack : undefined
      });
    }
  });


  // Historical backfill status — admin only, must be registered BEFORE the POST route
  apiRouter.get("/sync/backfill/status", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const status = await syncService.getHistoricalBackfillStatus();
      res.json(status);
    } catch (err) {
      console.error('[BackfillStatus] Error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Historical backfill: syncs all orders + payments for a given date range in weekly chunks.
  // Params (body OR query string):
  //   startDate  — ISO date string, e.g. "2025-01-01"  (defaults to Jan 1 2025)
  //   endDate    — ISO date string, e.g. "2026-03-22"  (defaults to now)
  //   chunkDays  — number of days per chunk            (defaults to 7)
  // Returns immediately with 202 Accepted; poll GET /api/sync/backfill/status for progress.
  apiRouter.post("/sync/backfill", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Accept params from both body and query string (body takes precedence)
      const body = req.body ?? {};
      const query = req.query ?? {};
      const rawStartDate = body.startDate ?? query.startDate;
      const rawEndDate   = body.endDate   ?? query.endDate;
      const rawChunkDays = body.chunkDays ?? query.chunkDays;

      const start = rawStartDate ? new Date(rawStartDate as string) : new Date('2025-01-01T00:00:00Z');
      const end   = rawEndDate   ? new Date(rawEndDate   as string) : new Date();
      const chunk = Number(rawChunkDays) > 0 ? Number(rawChunkDays) : 7;

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate or endDate' });
      }
      if (start >= end) {
        return res.status(400).json({ error: 'startDate must be before endDate' });
      }

      console.log(`[Backfill] Received request: ${start.toISOString()} → ${end.toISOString()}, chunkDays=${chunk}`);
      const result = await syncService.startHistoricalOrdersPaymentsBackfill(start, end, chunk);

      if (result.alreadyRunning) {
        return res.status(409).json({ success: false, message: result.message });
      }

      res.status(202).json({ success: true, message: result.message });
    } catch (err) {
      console.error('[Backfill] Error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });




  // Link gift cards to payment transactions - REMOVED (migrated to gift card service)
  
  // Update gift card activations endpoint - REMOVED (migrated to gift card service)

  // Update gift card amounts endpoint - REMOVED (migrated to gift card service)
  
  // Force update gift cards endpoint - REMOVED (migrated to gift card service)

  // Update gift card activations from transactions endpoint - REMOVED (migrated to gift card service)

  // Register the API router
  // Mount our routers
  app.use("/api/auth", authRouter);
  app.use("/api", apiRouter);

  // Create HTTP server, attach WebSocket, and return it
  const httpServer = createServer(app);
  initWebSocket(httpServer);
  return httpServer;
}