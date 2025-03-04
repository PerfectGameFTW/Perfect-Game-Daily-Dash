if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { db } from "./db"; // Import db directly
import { pgStorage } from "./pgStorage"; // Keep this for other storage operations
import {
  dateRangeSchema,
  transactions,
  giftCards,
  giftCardRedemptions,
  syncState,
  type InsertSyncState
} from "@shared/schema";
import { parse } from "date-fns";
import * as squareClient from "./squareClient";
import { and, gte, lte, sql, eq, gt, or, desc } from "drizzle-orm";

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


export async function registerRoutes(app: Express): Promise<Server> {
  const apiRouter = express.Router();

  // Get sync state
  apiRouter.get("/sync-state", async (req, res) => {
    try {
      // Get sync state directly from db
      const paymentsSyncState = await db.query.syncState.findFirst({
        where: eq(syncState.syncType, 'payments')
      });

      const giftCardsSyncState = await db.query.syncState.findFirst({
        where: eq(syncState.syncType, 'giftCards')
      });

      res.json({
        payments: paymentsSyncState || { status: 'none' },
        giftCards: giftCardsSyncState || { status: 'none' }
      });
    } catch (error) {
      console.error("Error getting sync state:", error);
      res.status(500).json({ error: "Failed to get sync state" });
    }
  });

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

      const hourlyRevenue = await pgStorage.getHourlyRevenue(parsedDateRange.data, startDate, endDate);

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

      // Get all completed transactions for the date range
      const allTransactions = await pgStorage.getTransactions(parsedDateRange.data, startDate, endDate, 'completed');

      // Calculate transaction breakdowns
      const detailedBreakdown = {
        partywirks: allTransactions.filter(t => t.squareData && typeof t.squareData === 'object' &&
          'note' in t.squareData && typeof t.squareData.note === 'string' &&
          t.squareData.note.toLowerCase().includes('partywirks'))
          .reduce((sum, t) => sum + t.amount, 0),
        tripleseat: allTransactions.filter(t => t.squareData && typeof t.squareData === 'object' &&
          'note' in t.squareData && typeof t.squareData.note === 'string' &&
          t.squareData.note.toLowerCase().includes('tripleseat'))
          .reduce((sum, t) => sum + t.amount, 0),
        tips: allTransactions.filter(t => t.squareData && typeof t.squareData === 'object' &&
          'note' in t.squareData && typeof t.squareData.note === 'string' &&
          t.squareData.note.toLowerCase().includes('tip'))
          .reduce((sum, t) => sum + t.amount, 0),
        serviceCharges: allTransactions.filter(t => t.squareData && typeof t.squareData === 'object' &&
          'note' in t.squareData && typeof t.squareData.note === 'string' &&
          t.squareData.note.toLowerCase().includes('service charge'))
          .reduce((sum, t) => sum + t.amount, 0),
        taxes: allTransactions.filter(t => t.squareData && typeof t.squareData === 'object' &&
          'note' in t.squareData && typeof t.squareData.note === 'string' &&
          t.squareData.note.toLowerCase().includes('tax'))
          .reduce((sum, t) => sum + t.amount, 0),
        refunds: allTransactions.filter(t => t.status === 'refunded')
          .reduce((sum, t) => sum + t.amount, 0),
        discountsAndComps: allTransactions.filter(t => t.squareData && typeof t.squareData === 'object' &&
          'note' in t.squareData && typeof t.squareData.note === 'string' &&
          (t.squareData.note.toLowerCase().includes('discount') || t.squareData.note.toLowerCase().includes('comp')))
          .reduce((sum, t) => sum + t.amount, 0),
        // Enhanced gift card detection logic
        giftCardSales: allTransactions.filter(t => {
          if (!t.squareData || typeof t.squareData !== 'object') return false;

          // Check if it's explicitly marked as a gift card transaction
          if (t.categoryId === 'giftCard') return true;

          // Check transaction notes for gift card mentions
          if ('note' in t.squareData && typeof t.squareData.note === 'string' &&
            t.squareData.note.toLowerCase().includes('gift card')) return true;

          // Check order data for gift card items
          if ('orderData' in t.squareData && t.squareData.orderData) {
            const order = t.squareData.orderData;
            if (order.lineItems) {
              return order.lineItems.some((item: any) =>
                item.itemType === 'GIFT_CARD' ||
                (item.name && item.name.toLowerCase().includes('gift card'))
              );
            }
          }

          return false;
        }).reduce((sum, t) => sum + t.amount, 0)
      };

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

  // Fix gift cards endpoint with improved error handling
  apiRouter.get("/fix-gift-cards", async (req, res) => {
    try {
      console.log("Starting fix for gift cards with zero amounts...");

      // Get all gift cards with zero amounts from the database
      const zeroAmountCards = await db.select()
        .from(giftCards)
        .where(eq(giftCards.amount, 0));

      console.log(`Found ${zeroAmountCards.length} gift cards with zero amounts`);

      // Fetch all gift cards from Square
      const squareGiftCards = await squareClient.fetchGiftCards();
      console.log(`Fetched ${squareGiftCards.length} gift cards from Square`);

      // Create a map for quick lookup with safe data processing
      const squareGiftCardMap = new Map();
      for (const card of squareGiftCards) {
        try {
          const safeCard = processSafeSquareData(card);
          squareGiftCardMap.set(safeCard.id, safeCard);
        } catch (error) {
          console.error(`Error processing Square card for map:`, error);
        }
      }

      let updatedCount = 0;
      let stillZeroCount = 0;

      for (const card of zeroAmountCards) {
        try {
          const squareCard = squareGiftCardMap.get(card.squareId);
          if (!squareCard) {
            console.log(`Card ${card.squareId} not found in Square data`);
            continue;
          }

          // Log the raw card data for debugging
          console.log(`Processing card ${card.squareId}...`);

          let amount = 0;
          if (squareCard.balanceMoney && squareCard.balanceMoney.amount) {
            const rawAmount = squareCard.balanceMoney.amount;
            amount = parseInt(String(rawAmount), 10) / 100;
            console.log(`Found amount in balanceMoney for card ${card.squareId}: $${amount} (raw: ${rawAmount})`);
          } else if (squareCard.balance_money && squareCard.balance_money.amount) {
            const rawAmount = squareCard.balance_money.amount;
            amount = parseInt(String(rawAmount), 10) / 100;
            console.log(`Found amount in balance_money for card ${card.squareId}: $${amount} (raw: ${rawAmount})`);
          }

          if (amount > 0) {
            // Prepare safe square data for database storage
            const safeSquareData = processSafeSquareData(squareCard);

            // Double-check serialization before database update
            try {
              // Verify the data is safe to store
              JSON.stringify(safeSquareData);

              // Update the database
              await db.update(giftCards)
                .set({
                  amount: amount,
                  squareData: safeSquareData
                })
                .where(eq(giftCards.squareId, card.squareId));

              console.log(`✅ Updated gift card ${card.squareId} amount from $0 to $${amount.toFixed(2)}`);
              updatedCount++;
            } catch (error) {
              console.error(`Failed to update gift card ${card.squareId}:`, error);
              stillZeroCount++;
            }
          } else {
            console.log(`⚠️ Card ${card.squareId} still has zero amount after extraction`);
            stillZeroCount++;
          }
        } catch (error) {
          console.error(`Error processing card ${card.squareId}:`, error);
          stillZeroCount++;
        }
      }

      // Return safe response
      const response = processSafeSquareData({
        success: true,
        totalProcessed: zeroAmountCards.length,
        updatedCount,
        stillZeroCount,
        message: `Successfully processed ${zeroAmountCards.length} cards, updated ${updatedCount}, ${stillZeroCount} remained at zero`
      });

      res.json(response);
    } catch (error) {
      console.error("Error fixing gift cards:", error);
      res.status(500).json({
        error: "Failed to fix gift cards",
        message: error instanceof Error ? error.message : "Unknown error"
      });
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

  // Add test endpoint after the fix-gift-cards endpoint
  apiRouter.get("/test-redemption", async (req, res) => {
    try {
      console.log("Testing gift card redemption processing...");

      // Create a test payment that simulates a gift card redemption
      const testPayment = {
        id: 'test_payment_' + Date.now(),
        sourceType: 'GIFT_CARD',
        amountMoney: {
          amount: 2500, // $25.00
          currency: 'USD'
        },
        status: 'COMPLETED',
        createdAt: new Date().toISOString(),
        orderId: 'test_order_' + Date.now(),
        sourceId: null // We'll set this to a real gift card ID
      };

      // Get a real gift card from our database to use in the test
      const sampleGiftCard = await db.query.giftCards.findFirst({
        where: eq(giftCards.amount, gt(0))
      });

      if (!sampleGiftCard) {
        return res.status(404).json({ error: "No gift cards found for testing" });
      }

      // Set the source ID to the real gift card's Square ID
      testPayment.sourceId = sampleGiftCard.squareId;

      console.log("Using gift card for test:", {
        squareId: sampleGiftCard.squareId,
        amount: sampleGiftCard.amount,
        redeemedAmount: sampleGiftCard.redeemedAmount
      });

      // Process the test payment through our regular flow
      const isRedemption = squareClient.isGiftCardRedemption(testPayment);
      console.log("Redemption detection result:", {
        isRedemption,
        testPayment
      });

      if (isRedemption) {
        // Convert the payment to our transaction model
        const transaction = squareClient.convertSquarePaymentToTransaction(testPayment);
        console.log("Converted transaction:", transaction);

        // Insert the transaction
        const createdTransaction = await db.insert(transactions)
          .values(transaction)
          .returning()
          .then(res => res[0]);

        console.log("Created transaction:", createdTransaction);

        // Create the redemption record
        const redemption = {
          giftCardId: sampleGiftCard.id,
          amount: Number(testPayment.amountMoney.amount) / 100,
          transactionId: createdTransaction.id,
          timestamp: new Date()
        };

        console.log("Creating redemption record:", redemption);

        const createdRedemption = await db.insert(giftCardRedemptions)
          .values(redemption)
          .returning()
          .then(res => res[0]);

        console.log("Created redemption record:", createdRedemption);

        // Update the gift card's redeemed amount
        const updatedGiftCard = await db.update(giftCards)
          .set({
            redeemedAmount: sql`COALESCE(${giftCards.redeemedAmount}, 0) + ${redemption.amount}`
          })
          .where(eq(giftCards.id, sampleGiftCard.id))
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

  // Update sync endpoint to use db directly for sync operations
  apiRouter.post("/sync", async (req, res) => {
    try {
      console.log("Starting sync process...");

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

      if (existingSyncState) {
        console.log('Sync already in progress:', existingSyncState);
        return res.status(409).json({
          error: 'Sync already in progress',
          lastSyncTime: existingSyncState.lastSyncedAt?.toISOString()
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
        .returning();

      console.log("Created sync state:", syncStateResult[0]);

      // Calculate sync window
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90); // Sync last 90 days by default

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

      for (const payment of payments) {
        try {
          const transaction = squareClient.convertSquarePaymentToTransaction(payment);
          await db.insert(transactions)
            .values(transaction)
            .onConflictDoNothing();
          processedCount++;
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

  // Add Order-related routes after existing routes
  apiRouter.get("/order-summary", async (req, res) => {
    try {
      // Parse date range from query (default to today if not provided)
      const dateRange = req.query.dateRange as string || "today";

      // Validate date range
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      // Parse custom date range if provided
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          startDate = startDateStr.includes('T') ? new Date(startDateStr) :
            parse(startDateStr, "yyyy-MM-dd", new Date());
          endDate = endDateStr.includes('T') ? new Date(endDateStr) :
            parse(endDateStr, "yyyy-MM-dd", new Date());

        } catch (err) {
          console.error('Error parsing order summary dates:', err);
          return res.status(400).json({ error: "Invalid date format" });
        }
      }

      const orderSummary = await pgStorage.getOrderSummary(parsedDateRange.data, startDate, endDate);
      res.json(orderSummary);
    } catch (error) {
      console.error("Error getting order summary:", error);
      const errorResponse = toErrorResponse(error);
      res.status(500).json(errorResponse);
    }
  });

  // Get detailed order information
  apiRouter.get("/orders/:orderId", async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      try {
        // Get order details
        const order = await pgStorage.getOrder(orderId);

        // Get line items with modifiers
        const lineItems = await pgStorage.getOrderItems(orderId);
        const lineItemsWithModifiers = await Promise.all(
          lineItems.map(async (item) => {
            const modifiers = await pgStorage.getOrderModifiers(item.id);
            return { ...item, modifiers };
          })
        );

        // Get discounts
        const discounts = await pgStorage.getOrderDiscounts(orderId);

        res.json({
          order,
          lineItems: lineItemsWithModifiers,
          discounts
        });
      } catch (error) {
        if (error instanceof OrderNotFoundError) {
          return res.status(404).json(toErrorResponse(error));
        }
        throw error;
      }
    } catch (error) {
      console.error("Error getting order details:", error);
      const errorResponse = toErrorResponse(error);
      res.status(500).json(errorResponse);
    }
  });

  // Sync orders with Square
  apiRouter.post("/sync/orders", async (req, res) => {
    try {
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.body.startDate || req.body.endDate) {
        try {
          if (req.body.startDate) {
            startDate = new Date(req.body.startDate);
            if (isNaN(startDate.getTime())) {
              throw new Error('Invalid start date');
            }
          }
          if (req.body.endDate) {
            endDate = new Date(req.body.endDate);
            if (isNaN(endDate.getTime())) {
              throw new Error('Invalid end date');
            }
          }
        } catch (err) {
          return res.status(400).json({ error: "Invalid date format in request" });
        }
      }

      await squareClient.syncOrders(pgStorage, startDate, endDate);
      res.json({ success: true, message: "Order sync initiated successfully" });
    } catch (error) {
      console.error("Error syncing orders:", error);
      const errorResponse = toErrorResponse(error);
      res.status(500).json(errorResponse);
    }
  });

  // Get orders by date range
  apiRouter.get("/orders", async (req, res) => {
    try {
      const dateRange = req.query.dateRange as string || "today";
      const parsedDateRange = dateRangeSchema.safeParse(dateRange);
      if (!parsedDateRange.success) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (req.query.startDate && req.query.endDate) {
        try {
          const startDateStr = req.query.startDate as string;
          const endDateStr = req.query.endDate as string;

          startDate = startDateStr.includes('T') ? new Date(startDateStr) :
            parse(startDateStr, "yyyy-MM-dd", new Date());
          endDate = endDateStr.includes('T') ? new Date(endDateStr) :
            parse(endDateStr, "yyyy-MM-dd", new Date());

          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            throw new Error('Invalid date');
          }
        } catch (err) {
          console.error('Error parsing order dates:', err);
          return res.status(400).json({ error: "Invalid date format" });
        }
      }

      try {
        const orders = await squareClient.fetchOrders(startDate, endDate);
        res.json(orders);
      } catch (error) {
        if (error instanceof OrderError) {
          return res.status(400).json(toErrorResponse(error));
        }
        throw error;
      }
    } catch (error) {
      console.error("Error getting orders:", error);
      const errorResponse = toErrorResponse(error);
      res.status(500).json(errorResponse);
    }
  });

  // Mount the API router
  app.use("/api", apiRouter);

  // Create and return HTTP server
  const httpServer = createServer(app);
  return httpServer;
}