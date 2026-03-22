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
import * as squareClientModule from "./squareClient";
import { squareClient as squareSDK } from "./squareClient";
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

      // Get daily summary data
      const summary = await pgStorage.getDailySummary(parsedDateRange.data, startDate, endDate);

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

  // Test endpoint to check gift card items in Square API
  apiRouter.get("/check-gift-card-items", async (req, res) => {
    try {
      // Fetch orders from yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const start = new Date(yesterday);
      start.setHours(0, 0, 0, 0);
      const end = new Date(yesterday);
      end.setHours(23, 59, 59, 999);

      console.log(`Fetching orders from ${start.toISOString()} to ${end.toISOString()}`);

      // Call the catalog API directly to look for gift card items
      console.log("Searching for catalog items related to gift cards...");

      // Use our dedicated function to search for gift card items
      const giftCardCatalogItems = await squareClient.searchCatalogForGiftCards();

      console.log(`Retrieved ${giftCardCatalogItems.length} gift card catalog items`);

      console.log(`Found ${giftCardCatalogItems.length} catalog items that might be gift cards`);

      // Get their IDs to search for in orders
      const giftCardItemIds = giftCardCatalogItems.map(item => item.id);

      // Now get all orders from yesterday
      const orders = await squareClient.fetchOrders(start, end);

      // Look for orders with items from our gift card catalog list or with names containing "gift card"
      const giftCardOrders = [];
      let totalGiftCardAmount = 0;

      for (const order of orders) {
        const lineItems = order.lineItems || [];
        const giftCardItems = [];

        for (const item of lineItems) {
          // Check if this line item is a gift card by:
          // 1. Matching catalog ID against our list
          // 2. Name containing "gift card"
          // 3. Item type being explicitly "GIFT_CARD"
          const isGiftCard =
            (item.catalogObjectId && giftCardItemIds.includes(item.catalogObjectId)) ||
            (item.name && item.name.toLowerCase().includes('gift card')) ||
            (item.itemType === 'GIFT_CARD');

          if (isGiftCard) {
            // Calculate the amount
            const amount = item.basePriceMoney && item.basePriceMoney.amount
              ? Number(item.basePriceMoney.amount) / 100
              : 0;

            totalGiftCardAmount += amount;

            giftCardItems.push({
              name: item.name || 'Gift Card',
              amount: amount,
              quantity: Number(item.quantity || 1),
              total: amount * Number(item.quantity || 1)
            });
          }
        }

        if (giftCardItems.length > 0) {
          giftCardOrders.push({
            orderId: order.id,
            createdAt: order.createdAt,
            totalAmount: order.totalMoney ? Number(order.totalMoney.amount) / 100 : 0,
            giftCardItems: giftCardItems
          });
        }
      }

      // Now check catalog API for item variations (may contain gift card info)
      console.log("Checking catalog for gift card item variations...");

      // Get all order IDs from Feb 25 to check in the database
      const feb25Orders = orders.map(o => o.id);

      // Check payments/transactions from Feb 25 for gift card references
      const feb25Payments = await squareClient.fetchPayments(start, end);

      // Find any payments with "gift card" in their notes or order names
      const giftCardPayments = feb25Payments.filter(payment => {
        // Check payment data for gift card clues
        const note = payment.note || '';
        const orderInfo = payment.orderName || '';

        return (
          note.toLowerCase().includes('gift card') ||
          note.toLowerCase().includes('gift certificate') ||
          orderInfo.toLowerCase().includes('gift card') ||
          orderInfo.toLowerCase().includes('gift certificate')
        );
      });

      console.log(`Found ${giftCardPayments.length} payments potentially related to gift cards`);

      // Calculate the total from these payments
      const giftCardPaymentTotal = giftCardPayments.reduce((total, payment) => {
        const amount = payment.amountMoney && payment.amountMoney.amount
          ? Number(payment.amountMoney.amount) / 100
          : 0;
        return total + amount;
      }, 0);

      res.json({
        date: yesterday.toLocaleDateString(),
        totalOrders: orders.length,
        totalPayments: feb25Payments.length,
        giftCardData: {
          catalogItems: {
            count: giftCardCatalogItems.length,
            items: giftCardCatalogItems.map(item => ({
              id: item.id,
              name: item.itemData?.name,
              description: item.itemData?.description
            }))
          },
          orders: {
            count: giftCardOrders.length,
            total: totalGiftCardAmount,
            details: giftCardOrders
          },
          payments: {
            count: giftCardPayments.length,
            total: giftCardPaymentTotal,
            details: giftCardPayments.map(p => ({
              id: p.id,
              amount: p.amountMoney ? Number(p.amountMoney.amount) / 100 : 0,
              note: p.note,
              orderId: p.orderId,
              orderName: p.orderName,
              time: p.createdAt
            }))
          }
        }
      });
    } catch (error) {
      console.error("Error checking gift card items:", error);
      res.status(500).json({
        error: "Failed to check gift card items",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Fix gift cards endpoint - REMOVED (migrated to gift card service)
  // Endpoint to sync orders from Square API
  apiRouter.get("/sync-orders", async (req, res) => {
    try {
      console.log("Starting order sync from Square API...");
      
      // Parse start and end dates if provided
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (req.query.startDate) {
        try {
          startDate = new Date(req.query.startDate as string);
          console.log(`Using provided start date: ${startDate.toISOString()}`);
        } catch (error) {
          return res.status(400).json({ error: "Invalid start date format" });
        }
      }
      
      if (req.query.endDate) {
        try {
          endDate = new Date(req.query.endDate as string);
          console.log(`Using provided end date: ${endDate.toISOString()}`);
        } catch (error) {
          return res.status(400).json({ error: "Invalid end date format" });
        }
      }
      
      // Default to last 30 days if no startDate specified
      if (!startDate) {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        console.log(`Using default start date (30 days ago): ${startDate.toISOString()}`);
      }
      
      console.log(`Syncing orders from ${startDate.toISOString()} to ${endDate?.toISOString() || 'now'}`);
      
      // Call the syncOrders function from squareClient
      await squareClient.syncOrders(startDate, endDate);
      
      // Get counts from database to show success
      const orderCount = await db
        .select({ count: count() })
        .from(orders)
        .then(result => result[0].count);
        
      return res.json({
        success: true,
        message: "Order sync completed successfully",
        orderCount
      });
    } catch (error) {
      console.error("Error syncing orders:", error);
      return res.status(500).json({
        error: "Failed to sync orders",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
  
  // Fix gift cards endpoint - REMOVED (migrated to gift card service)

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
              states: ['COMPLETED']
            }
          },
          sort: {
            sortField: 'CREATED_AT',
            sortOrder: 'DESC'
          }
        },
        limit: 3 // Just get a few to test
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

  // Add a simple sync endpoint
  apiRouter.post("/simple-sync", async (req, res) => {
    try {
      console.log("Starting simple sync process...");

      // Check Square API connection first
      try {
        const connectionTest = await squareClient.testConnection();
        console.log("Square API connection test:", connectionTest);
      } catch (apiError) {
        console.error("Square API connection failed:", apiError);
        return res.status(503).json({
          error: "Failed to connect to Square API"
        });
      }

      // Calculate sync window
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30); // Sync last 30 days

      console.log(`Fetching payments from ${startDate.toISOString()} to ${endDate.toISOString()}`);

      // Fetch payments from Square
      let payments = [];
      try {
        payments = await squareClient.fetchPayments(startDate, endDate);
        console.log(`Successfully fetched ${payments.length} payments from Square`);
      } catch (fetchError) {
        console.error("Error fetching payments:", fetchError);
        throw new Error(`Failed to fetch payments: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
      }

      // Process payments - avoid using onConflictDoUpdate which causes SQL errors
      let processedCount = 0;
      let errorCount = 0;

      for (const payment of payments) {
        try {
          // Check if transaction already exists
          const existingTransaction = await db.query.transactions.findFirst({
            where: eq(transactions.squareId, payment.id)
          });

          // Skip if it already exists
          if (existingTransaction) {
            continue;
          }

          // Create new transaction
          const transaction = squareClient.convertSquarePaymentToTransaction(payment);
          await db.insert(transactions).values(transaction);
          processedCount++;
        } catch (error) {
          errorCount++;
          console.error(`Error processing payment ${payment.id}:`, error);
        }
      }

      // Now sync gift cards as well
      let giftCardProcessed = 0;
      let giftCardErrorCount = 0;

      try {
        console.log("Starting gift card sync process...");

        // Fetch gift cards and activation amounts from Activities API in parallel
        const [squareGiftCards, activationMap] = await Promise.all([
          squareClient.fetchGiftCards(),
          squareClient.fetchGiftCardActivitiesMap()
        ]);
        console.log(`Fetched ${squareGiftCards.length} gift cards from Square; activation amounts for ${activationMap.size} cards`);

        // Process each gift card – update if exists, otherwise insert new record
        for (const card of squareGiftCards) {
          try {
            // Process the Square gift card data to ensure it's safe for JSON serialization
            const safeCard = ensureSerializable(card);

            // Attempt to find an existing gift card record by squareId
            const existingCard = await db.query.giftCards.findFirst({
              where: eq(giftCards.squareId, safeCard.id)
            });

            // Determine the current balance (convert from cents to dollars)
            let amount = 0;
            if(safeCard.balanceMoney && safeCard.balanceMoney.amount) {
              amount = Number(safeCard.balanceMoney.amount) / 100;
            } else if (safeCard.balance_money && safeCard.balance_money.amount) {
              amount = Number(safeCard.balance_money.amount) / 100;
            }

            // Determine activation amount from the Activities API (most accurate source)
            const activationAmountFromApi = activationMap.get(safeCard.id);

            // Extract the actual purchase date from Square data if available
            // Otherwise use existing date or today's date as fallback
            let purchaseDate = new Date();
            if (safeCard.createdAt) {
              purchaseDate = new Date(safeCard.createdAt);
            } else if (existingCard && existingCard.purchaseDate) {
              purchaseDate = existingCard.purchaseDate;
            }

            if (existingCard) {
              // Update the existing gift card record
              // Always update activation_amount when we have a value from the Activities API
              const updatePayload: Partial<typeof giftCards.$inferInsert> = {
                amount,
                squareData: safeCard,
                ...(safeCard.createdAt ? { purchaseDate } : {}),
                ...(activationAmountFromApi !== undefined && activationAmountFromApi > 0
                  ? { activationAmount: activationAmountFromApi }
                  : {})
              };
              await db.update(giftCards)
                .set(updatePayload)
                .where(eq(giftCards.squareId, safeCard.id));
              console.log(`Updated gift card ${safeCard.id} with amount $${amount.toFixed(2)}, activation $${activationAmountFromApi ?? existingCard.activationAmount ?? 'null'}`);
            } else {
              // Insert a new gift card record
              const newCard: typeof giftCards.$inferInsert = {
                squareId: safeCard.id,
                gan: safeCard.gan || '',
                amount,
                squareData: safeCard,
                purchaseDate,
                isActive: true,
                ...(activationAmountFromApi !== undefined && activationAmountFromApi > 0
                  ? { activationAmount: activationAmountFromApi }
                  : {})
              };

              await db.insert(giftCards).values(newCard);
              console.log(`Inserted new gift card ${safeCard.id} with amount $${amount.toFixed(2)}, activation $${activationAmountFromApi ?? 'null'}`);
            }

            giftCardProcessed++;
          } catch (cardError) {
            giftCardErrorCount++;
            console.error(`Error processing gift card ${card.id}:`, cardError);
          }
        }

        // Update the gift card sync state
        const giftCardSyncState = await db.query.syncState.findFirst({
          where: eq(syncState.syncType, 'giftCards')
        });

        if (giftCardSyncState) {
          await db.update(syncState)
            .set({
              lastSyncedAt: new Date(),
              status: 'completed',
              processedCount: giftCardProcessed,
              totalCount: squareGiftCards.length,
              isComplete: true,
              errorMessage: giftCardErrorCount > 0 ? `${giftCardErrorCount} errors occurred` : null
            })
            .where(eq(syncState.id, giftCardSyncState.id));
        } else {
          // Create sync state record if it doesn't exist
          await db.insert(syncState).values({
            syncType: 'giftCards',
            lastSyncedAt: new Date(),
            status: 'completed',
            processedCount: giftCardProcessed,
            totalCount: squareGiftCards.length,
            isComplete: true,
            errorMessage: giftCardErrorCount > 0 ? `${giftCardErrorCount} errors occurred` : null
          });
        }

        console.log(`Gift card sync completed: processed ${giftCardProcessed}, errors ${giftCardErrorCount}`);
      } catch (giftCardError) {
        console.error("Error syncing gift cards:", giftCardError);

        // Update gift card sync state to reflect the error
        try {
          await db.update(syncState)
            .set({
              lastSyncedAt: new Date(),
              status: 'error',
              errorMessage: giftCardError instanceof Error ? giftCardError.message : 'Unknown error during gift card sync'
            })
            .where(eq(syncState.syncType, 'giftCards'));
        } catch (updateError) {
          console.error("Failed to update gift card sync state:", updateError);
        }
      }

      // Return simple success response
      res.json({
        success: true,
        processed: {
          payments: processedCount,
          giftCards: giftCardProcessed
        },
        errors: {
          payments: errorCount,
          giftCards: giftCardErrorCount
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error("Error during simple sync:", error);

      // Update sync state to failed if we have a sync state
      try {
        await db.update(syncState)
          .set({
            status: 'failed',
            lastSyncedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : "Unknown error"
          })
          .where(eq(syncState.syncType, 'payments'));
      } catch (updateError) {
        console.error("Failed to update sync state:", updateError);
      }

      res.status(500).json({
        error: "Failed to sync data",
        message: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      });
    }
  });

  // Add test endpoint after the fix-gift-cards endpoint
  apiRouter.get("/test-redemption", async (req, res) => {
    try {
      console.log("Creating test gift card redemption...");

      // Create a sample gift card (for testing only)
      const sampleGiftCard = {
        id: 1,
        squareId: "gftc:test-gift-card-id",
        gan: "1234567890",
        amount: 50.0,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'ACTIVE'
      };

      // Create sample payment with gift card redemption details
      const samplePayment = {
        id: "test-payment-id",
        orderId: "test-order-id",
        amountMoney: { amount: 2500, currency: "USD" },
        status: "COMPLETED",
        sourceType: "CARD",
        cardDetails: {
          card: {
            cardBrand: "GIFT_CARD",
            id: sampleGiftCard.squareId
          },
          entryMethod: "MANUAL",
          status: "CAPTURED",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        note: "Test gift card redemption"
      };

      // Check if the payment is a gift card redemption
      const isGiftCardRedemption = squareClient.isGiftCardRedemption(samplePayment);

      if (isGiftCardRedemption) {
        console.log("Test payment is a gift card redemption");

        // Convert the payment to a transaction for storage
        const transaction = squareClient.convertSquarePaymentToTransaction(samplePayment);

        // Create the transaction
        const createdTransaction = await db.insert(transactions)
          .values(transaction)
          .returning()
          .then(res => res[0]);

        console.log("Created transaction:", createdTransaction);

        // Create a gift card redemption record
        const redemption = {
          giftCardId: sampleGiftCard.id,
          transactionId: createdTransaction.id,
          amount: transaction.amount,
          timestamp: new Date(),
          status: 'completed',
          squarePaymentId: samplePayment.id
        };

        const createdRedemption = await db.insert(giftCardRedemptions)
          .values(redemption)
          .returning()
          .then(res => res[0]);

        console.log("Created gift card redemption:", createdRedemption);

        // Update the gift card amount
        const updatedGiftCard = await db.update(giftCards)
          .set({
            amount: sampleGiftCard.amount - transaction.amount,
            updatedAt: new Date()
          })
          .where(eq(giftCards.squareId, sampleGiftCard.squareId))
          .returning()
          .then(res => res[0]);
        console.log("Updated giftcard:", updatedGiftCard);

        res.json({
          success: true,
          message: "Test redemption processed successfully",
          details: {
            giftCard: sampleGiftCard,
            transaction: createdTransaction,
            redemption: createdRedemption,
            updatedGiftCard
          }
        });
      } else {
        res.status(400).json({
          success: false,
          error: "Test payment was not detected as a gift card redemption"
        });
      }
    } catch (error) {
      console.error("Error processing test redemption:", error);
      res.status(500).json({
        success: false,
        error: "Failed to process test redemption",
        message: error instanceof Error ? error.message : "Unknown error"
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

  // Add sync status endpoint right before the sync endpoint
  apiRouter.get("/sync-status", async (req, res) => {
    try {
      // Get the current sync state
      const paymentsSyncState = await db.query.syncState.findFirst({
        where: eq(syncState.syncType, 'payments')
      });

      if (!paymentsSyncState) {
        return res.json({
          status: 'none',
          message: 'No sync has been attempted yet'
        });
      }

      // Calculate elapsed time if sync is running
      let elapsedTime = null;
      if (paymentsSyncState.status === 'running' && paymentsSyncState.lastSyncedAt) {
        const elapsedMs = Date.now() - paymentsSyncState.lastSyncedAt.getTime();
        elapsedTime = {
          ms: elapsedMs,
          seconds: Math.floor(elapsedMs / 1000),
          minutes: Math.floor(elapsedMs / (1000 * 60))
        };
      }

      // Check if sync is likely stuck (running for more than 5 minutes)
      const isLikelyStuck = paymentsSyncState.status === 'running' &&
                           paymentsSyncState.lastSyncedAt &&
                           (Date.now() - paymentsSyncState.lastSyncedAt.getTime() > 5 * 60 * 1000);

      res.json({
        syncState: paymentsSyncState,
        elapsedTime,
        isLikelyStuck
      });
    } catch (error) {
      console.error("Error getting sync status:", error);
      res.status(500).json({
        error: "Failed to get sync status",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Add reset sync endpoint
  apiRouter.post("/reset-sync", async (req, res) => {
    try {
      // Update sync state to reset it
      await db.update(syncState)
        .set({
          status: 'reset',
          lastSyncedAt: new Date(),
          isComplete: true,
          errorMessage: 'Reset by user'
        })
        .where(eq(syncState.syncType, 'payments'));

      res.json({
        success: true,
        message: 'Sync state has been reset'
      });
    } catch (error) {
      console.error("Error resetting sync state:", error);
      res.status(500).json({
        error: "Failed to reset sync state",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Update sync endpoint to use db directly for sync operations
  apiRouter.post("/sync", async (req, res) => {
    try {
      console.log("Starting sync process...");

      // Allow force sync option
      const forceSync = req.query.force === 'true';

      // Check Square API connection first
      try {
        const connectionTest = await squareClient.testConnection();
        console.log("Square API connection test:", connectionTest);
      } catch (apiError) {
        console.error("Square API connection failed:", apiError);
        return res.status(503).json({
          error: "Failed to connect to Square API",
          message: apiError instanceof Error ? apiError.message : "Unknown error"
        });
      }

      // Check if a sync is already running
      const existingSyncState = await db.query.syncState.findFirst({
        where: and(
          eq(syncState.syncType, 'payments'),
          eq(syncState.status, 'running')
        )
      });

      if (existingSyncState && !forceSync) {
        // Check if sync is likely stuck (running for more than 5 minutes)
        const isLikelyStuck = existingSyncState.lastSyncedAt &&
                             (Date.now() - existingSyncState.lastSyncedAt.getTime() > 5 * 60 * 1000);

        console.log('Sync already in progress:', existingSyncState);
        return res.status(409).json({
          error: 'Sync already in progress',
          lastSyncTime: existingSyncState.lastSyncedAt?.toISOString(),
          isLikelyStuck,
          message: isLikelyStuck ? 'The previous sync may be stuck. You can force a new sync with ?force=true' : undefined
        });
      }

      // Create new sync state
      const syncStartTime = new Date();
      const newSyncState = {
        syncType: 'payments',
        status: 'running',
        lastSyncedAt: syncStartTime,
        currentPage: 1,
        processedCount: 0,
        isComplete: false,
        errorMessage: null
      };

      // Insert sync state
      const syncStateResult = await db.insert(syncState)
        .values(newSyncState)
        .onConflictDoUpdate({
          target: [syncState.syncType],
          set: newSyncState
        })
        .returning();

      console.log("Created sync state:", syncStateResult[0]);

      // Calculate sync window
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30); // Reduced to 30 days for faster sync

      console.log(`Fetching payments from ${startDate.toISOString()} to ${endDate.toISOString()}`);

      // Fetch and process payments
      let payments = [];
      try {
        payments = await squareClient.fetchPayments(startDate, endDate);
        console.log(`Successfully fetched ${payments.length} payments from Square`);
      } catch (fetchError) {
        const errorMessage = fetchError instanceof Error ? fetchError.message : 'Unknown error';
        if (errorMessage.includes('Sync timeout reached')) {
          return res.status(408).json({
            error: "Sync timeout",
            message: "The sync process took too long. Please try again with a smaller date range."
          });
        }
        throw new Error(`Failed to fetch payments: ${errorMessage}`);
      }

      // Process payments
      let processedCount = 0;
      let errorCount = 0;
      const errors = [];

      // Update sync state with progress info
      await db.update(syncState)
        .set({
          totalCount: payments.length,
          status: 'processing',
          lastSyncedAt: new Date()
        })
        .where(eq(syncState.id, syncStateResult[0].id));

      for (const payment of payments) {
        try {
          const transaction = squareClient.convertSquarePaymentToTransaction(payment);
          await db.insert(transactions)
            .values(transaction)
            .onConflictDoNothing();
          processedCount++;

          // Update progress every 10 transactions
          if (processedCount % 10 === 0) {
            await db.update(syncState)
              .set({
                processedCount,
                lastSyncedAt: new Date()
              })
              .where(eq(syncState.id, syncStateResult[0].id));
          }
        } catch (error) {
          errorCount++;
          console.error(`Error processing payment ${payment.id}:`, error);
          errors.push({
            paymentId: payment.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Update sync state to completed
      await db.update(syncState)
        .set({
          status: 'completed',
          lastSyncedAt: new Date(),
          processedCount,
          isComplete: true,
          errorMessage: errorCount > 0 ? `Failed to process ${errorCount} payments` : null
        })
        .where(eq(syncState.id, syncStateResult[0].id));

      // Return success response
      res.json({
        success: true,
        lastSyncTime: new Date().toISOString(),
        processed: processedCount,
        total: payments.length,
        errors: errorCount > 0 ? errors : undefined
      });

    } catch (error) {
      console.error("Sync process failed:", {
        error,
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });

      // Update sync state to failed if we have a sync state
      try {
        await db.update(syncState)
          .set({
            status: 'failed',
            lastSyncedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : "Unknown error"
          })
          .where(eq(syncState.syncType, 'payments'));
      } catch (updateError) {
        console.error("Failed to update sync state:", updateError);
      }

      res.status(500).json({
        error: "Failed to sync data",
        message: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      });
    }
  });

  // Link gift cards to payment transactions - REMOVED (migrated to gift card service)
  
  // Update gift card activations endpoint - REMOVED (migrated to gift card service)

  // Update gift card amounts endpoint - REMOVED (migrated to gift card service)
  
  // Force update gift cards endpoint - REMOVED (migrated to gift card service)

  // Update gift card activations from transactions endpoint - REMOVED (migrated to gift card service)

  // Register the API router
  // Mount our routers
  app.use("/api", apiRouter);
  app.use("/api/auth", authRouter);

  // Create HTTP server, attach WebSocket, and return it
  const httpServer = createServer(app);
  initWebSocket(httpServer);
  return httpServer;
}