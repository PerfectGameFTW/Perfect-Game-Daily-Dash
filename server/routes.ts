if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { pgStorage, db } from "./pgStorage";
import {
  dateRangeSchema,
  transactions,
  giftCards
} from "@shared/schema";
import { parse } from "date-fns";
import * as squareClient from "./squareClient";
import { and, gte, lte, sql, eq } from "drizzle-orm";

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

export async function registerRoutes(app: Express): Promise<Server> {
  const apiRouter = express.Router();

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

  // Simple mutex to prevent concurrent syncs
  let isSyncRunning = false;
  let syncStartTime: Date | null = null;

  // Function to check if sync has been running too long (30 minutes)
  const hasSyncTimedOut = (): boolean => {
    if (!syncStartTime) return false;

    const timeoutMinutes = 30; // Consider sync stalled after 30 minutes
    const now = new Date();
    const diffMs = now.getTime() - syncStartTime.getTime();
    const diffMinutes = diffMs / (1000 * 60);

    return diffMinutes > timeoutMinutes;
  };

  // Unified sync route to handle all transaction and gift card syncing
  apiRouter.post("/sync", async (req, res) => {
    try {
      // Check if a sync is already running
      if (isSyncRunning) {
        // If sync has been running too long, consider it stalled and allow a new one
        if (hasSyncTimedOut()) {
          console.log("Previous sync timed out after 30 minutes. Allowing new sync to start.");
          isSyncRunning = false;
        } else {
          console.log("Sync already in progress. Skipping new sync request.");

          // Get current sync state from database for response
          const paymentsSyncState = await pgStorage.getSyncState('payments');
          const lastSyncTime = paymentsSyncState?.lastSyncedAt || new Date(0);

          return res.status(409).json({
            success: false,
            error: "A sync is already in progress. Please try again later.",
            lastSyncTime: lastSyncTime.toISOString()
          });
        }
      }

      // Set the lock to prevent concurrent syncs
      isSyncRunning = true;
      syncStartTime = new Date();

      console.log("Starting unified sync with Square API...");
      const results = {
        transactions: 0,
        orders: 0,
        giftCards: 0
      };

      // Check Square API connection status
      const accessToken = process.env.SQUARE_ACCESS_TOKEN;
      const locationId = process.env.SQUARE_LOCATION_ID;

      if (!accessToken || !locationId) {
        console.error("Square API credentials are missing. Check environment variables.");
        isSyncRunning = false;
        return res.status(500).json({
          success: false,
          error: "Square API credentials are missing."
        });
      }

      console.log("Using Square API with Location ID:", locationId);

      // Get date parameters from request if provided
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      let isInitialSync = false;

      if (req.query.startDate && req.query.endDate) {
        // Handle manually provided date range
        startDate = new Date(req.query.startDate as string);
        endDate = new Date(req.query.endDate as string);
        console.log(`Using provided date range: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
      } else {
        // Check if we've done a sync before
        const lastPaymentSync = await pgStorage.getSyncState('payments');

        if (lastPaymentSync && lastPaymentSync.isComplete && lastPaymentSync.lastSyncedAt) {
          // This is not initial sync - get data since last sync
          console.log("Found previous complete sync at:", lastPaymentSync.lastSyncedAt);

          // Use last sync date as starting point with 1 day buffer for overlap
          startDate = new Date(lastPaymentSync.lastSyncedAt);
          startDate.setDate(startDate.getDate() - 1); // 1 day overlap for safety
          endDate = new Date(); // Current time

          console.log(`Incremental sync from ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
        } else {
          // First sync - use default 90-day window
          const now = new Date();
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 90);
          endDate = now;
          isInitialSync = true;
          console.log(`Initial sync using default 90-day window: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
        }
      }

      // STEP 1: Sync Payments
      // ------------------------
      console.log("--- STEP 1: SYNCING PAYMENTS ---");

      // Check for existing payments sync state
      let paymentsSyncState = await pgStorage.getSyncState('payments');
      let lastCheckpoint: any = null;

      if (paymentsSyncState && !paymentsSyncState.isComplete) {
        // Resume from checkpoint
        console.log("Resuming payments sync from checkpoint:", {
          lastSyncAt: paymentsSyncState.lastSyncedAt,
          processed: paymentsSyncState.processedCount,
          total: paymentsSyncState.totalCount
        });
        lastCheckpoint = paymentsSyncState.lastCheckpoint;
      } else {
        // Create a new sync state record or update existing one
        const syncData: InsertSyncState = {
          syncType: 'payments',
          lastSyncedAt: new Date(),
          processedCount: 0,
          totalCount: 0,
          isComplete: false,          status: 'in_progress',
          lastCheckpoint: { lastPosition: 0 }
        };

        if (paymentsSyncState) {
          // Update existing record
          paymentsSyncState = await pgStorage.updateSyncState(paymentsSyncState.id, syncData);
        } else {
          //          // Create new record
          paymentsSyncState = await pgStorage.createSyncState(syncData);
        }
        console.log("Created new payments sync state record:", paymentsSyncState.id);
      }

      // Fetch payments from Square with date range
      console.log(`Fetching payments for ${startDate.toLocaleString()} to ${endDate.toLocaleString()}...`);
      const payments = await squareClient.fetchPayments(startDate, endDate);
      console.log(`Fetched ${payments.length} total payments`);

      // Update sync state with total payment count
      paymentsSyncState = await pgStorage.updateSyncState(paymentsSyncState.id, {
        totalCount: payments.length,
        status: 'processing',
      });

      // Process each payment with robust error handling
      let processedCount = lastCheckpoint?.lastPosition || 0;
      let existingCount = 0;
      let errorCount = 0;

      // Start from the last checkpoint position
      for (let i = processedCount; i < payments.length; i++) {
        try {
          const payment = payments[i];
          processedCount = i + 1;

          // Create checkpoint every 50 records
          if (processedCount % 50 === 0) {
            console.log(`Processing payment ${processedCount} of ${payments.length}...`);

            // Update checkpoint in database
            await pgStorage.updateSyncState(paymentsSyncState.id, {
              processedCount: processedCount,
              lastSyncedAt: new Date(),
              lastCheckpoint: { lastPosition: processedCount }
            });
          }

          // Check if we already have this transaction
          const existing = await pgStorage.getTransactionBySquareId(payment.id);
          if (!existing) {
            // Convert to our model and save
            const transaction = squareClient.convertSquarePaymentToTransaction(payment);
            await pgStorage.createTransaction(transaction);
            results.transactions++;
          } else {
            existingCount++;
          }
        } catch (recordError) {
          // Log the error but continue processing
          errorCount++;
          console.error(`Error processing payment at position ${i}:`, recordError);

          // Create a checkpoint so we don't lose progress
          if (i % 10 === 0) {
            await pgStorage.updateSyncState(paymentsSyncState.id, {
              processedCount: i,
              lastSyncedAt: new Date(),
              lastCheckpoint: { lastPosition: i },
              errorMessage: `Skipped ${errorCount} payment records with errors`
            });
          }

          // Continue with next record
          continue;
        }
      }

      console.log(`Payments sync complete: ${processedCount} processed, ${existingCount} already existed, ${errorCount} errors, added ${results.transactions} new transactions`);

      // Mark payments sync as complete
      await pgStorage.updateSyncState(paymentsSyncState.id, {
        processedCount: payments.length,
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date()
      });

      // STEP 2: Sync Orders and detect gift card line items
      // --------------------------------------------------
      console.log("--- STEP 2: SYNCING ORDERS AND DETECTING GIFT CARDS ---");

      // Check for existing orders sync state
      let ordersSyncState = await pgStorage.getSyncState('orders');
      let ordersCheckpoint: any = null;

      if (ordersSyncState && !ordersSyncState.isComplete) {
        // Resume from checkpoint
        console.log("Resuming orders sync from checkpoint:", {
          lastSyncAt: ordersSyncState.lastSyncedAt,
          processed: ordersSyncState.processedCount,
          total: ordersSyncState.totalCount
        });
        ordersCheckpoint = ordersSyncState.lastCheckpoint;
      } else {
        // Create a new sync state record or update existing one
        const syncData: InsertSyncState = {
          syncType: 'orders',
          lastSyncedAt: new Date(),
          processedCount: 0,
          totalCount: 0,
          isComplete: false,
          status: 'in_progress',
          lastCheckpoint: { lastPosition: 0 }
        };

        if (ordersSyncState) {
          // Update existing record
          ordersSyncState = await pgStorage.updateSyncState(ordersSyncState.id, syncData);
        } else {
          // Create new record
          ordersSyncState = await pgStorage.createSyncState(syncData);
        }
        console.log("Created new orders sync state record:", ordersSyncState.id);
      }

      // Fetch orders from Square with date range
      console.log(`Fetching orders for ${startDate.toLocaleString()} to ${endDate.toLocaleString()}...`);
      const orders = await squareClient.fetchOrders(startDate, endDate);
      console.log(`Fetched ${orders.length} total orders`);

      // Update sync state with total order count
      ordersSyncState = await pgStorage.updateSyncState(ordersSyncState.id, {
        totalCount: orders.length,
        status: 'processing',
      });

      // Process orders and identify gift cards with checkpoints
      let giftCardSalesCount = 0;
      let giftCardSalesAmount = 0;
      let ordersProcessed = ordersCheckpoint?.lastPosition || 0;
      let ordersErrorCount = 0;

      // Process each order to identify gift card sales
      for (let i = ordersProcessed; i < orders.length; i++) {
        try {
          const order = orders[i];
          ordersProcessed = i + 1;

          // Create checkpoint every 20 orders
          if (ordersProcessed % 20 === 0) {
            console.log(`Processing order ${ordersProcessed} of ${orders.length}...`);

            // Update checkpoint in database
            await pgStorage.updateSyncState(ordersSyncState.id, {
              processedCount: ordersProcessed,
              lastSyncedAt: new Date(),
              lastCheckpoint: { lastPosition: ordersProcessed }
            });
          }

          // Analyze order for gift card detection
          if (order.lineItems) {
            for (const lineItem of order.lineItems) {
              const itemName = (lineItem.name || '').toLowerCase();

              // Check if this is a gift card line item
              if (
                itemName.includes('gift') ||
                itemName.includes('gift card') ||
                (lineItem.note && lineItem.note.toLowerCase().includes('gift')) ||
                lineItem.itemType === 'GIFT_CARD'
              ) {
                giftCardSalesCount++;

                // Calculate the amount
                const quantity = Number(lineItem.quantity || '1');
                const unitPrice = lineItem.basePriceMoney && lineItem.basePriceMoney.amount
                  ? Number(lineItem.basePriceMoney.amount) / 100
                  : 0;

                const totalPrice = quantity * unitPrice;
                giftCardSalesAmount += totalPrice;

                console.log(`Found gift card sale: ${lineItem.name}, amount: $${totalPrice.toFixed(2)}`);
              }
            }
          }

          results.orders++;

        } catch (orderError) {
          // Log the error but continue processing
          ordersErrorCount++;
          console.error(`Error processing order at position ${i}:`, orderError);

          // Create a checkpoint so we don't lose progress
          if (i % 10 === 0) {
            await pgStorage.updateSyncState(ordersSyncState.id, {
              processedCount: i,
              lastSyncedAt: new Date(),
              lastCheckpoint: { lastPosition: i },
              errorMessage: `Skipped ${ordersErrorCount} order records with errors`
            });
          }

          // Continue with next record
          continue;
        }
      }

      console.log(`Orders sync complete: ${ordersProcessed} processed, encountered ${ordersErrorCount} errors`);
      console.log(`Gift card analysis: Found ${giftCardSalesCount} gift card items totaling $${giftCardSalesAmount.toFixed(2)}`);

      // Mark orders sync as complete
      await pgStorage.updateSyncState(ordersSyncState.id, {
        processedCount: orders.length,
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date()
      });

      // STEP 3: Sync Gift Cards
      // ----------------------
      console.log("--- STEP 3: SYNCING GIFT CARDS ---");

      // Check for existing gift cards sync state
      let giftCardsSyncState = await pgStorage.getSyncState('giftCards');
      let giftCardsCheckpoint: any = null;

      if (giftCardsSyncState && !giftCardsSyncState.isComplete) {
        // Resume from checkpoint
        console.log("Resuming gift cards sync from checkpoint:", {
          lastSyncAt: giftCardsSyncState.lastSyncedAt,
          processed: giftCardsSyncState.processedCount,
          total: giftCardsSyncState.totalCount
        });
        giftCardsCheckpoint = giftCardsSyncState.lastCheckpoint;
      } else {
        // Create a new sync state record or update existing one
        const syncData: InsertSyncState = {
          syncType: 'giftCards',
          lastSyncedAt: new Date(),
          processedCount: 0,
          totalCount: 0,
          isComplete: false,
          status: 'in_progress',
          lastCheckpoint: { lastPosition: 0 }
        };

        if (giftCardsSyncState) {
          // Update existing record
          giftCardsSyncState = await pgStorage.updateSyncState(giftCardsSyncState.id, syncData);
        } else {
          // Create new record
          giftCardsSyncState = await pgStorage.createSyncState(syncData);
        }
        console.log("Created new gift cards sync state record:", giftCardsSyncState.id);
      }

      // Fetch ALL gift cards from Square
      console.log("Fetching all gift cards from Square...");
      const giftCards = await squareClient.fetchGiftCards();
      console.log(`Fetched ${giftCards.length} total gift cards`);

      // Debugging: Log the first gift card structure
      if (giftCards.length > 0) {
        console.log("SAMPLE GIFT CARD DATA STRUCTURE:", JSON.stringify(giftCards[0], null, 2));
      }

      // Update sync state with total gift card count
      giftCardsSyncState = await pgStorage.updateSyncState(giftCardsSyncState.id, {
        totalCount: giftCards.length,
        status: 'processing',
      });

      // Process each gift card with error handling
      let giftCardPosition = giftCardsCheckpoint?.lastPosition || 0;
      let giftCardErrorCount = 0;
      let nonZeroAmountCards = 0;
      let zeroAmountCards = 0;

      // Step 1: First pass to process and add all gift cards
      console.log("FIRST PASS: Adding all gift cards to database...");
      for (let i = giftCardPosition; i < giftCards.length; i++) {
        try {
          const giftCard = giftCards[i];
          giftCardPosition = i + 1;

          // Create checkpoint every 10 gift cards
          if (giftCardPosition % 10 === 0) {
            console.log(`Processing gift card ${giftCardPosition} of ${giftCards.length}...`);

            // Update checkpoint in database
            await pgStorage.updateSyncState(giftCardsSyncState.id, {
              processedCount: giftCardPosition,
              lastSyncedAt: new Date(),
              lastCheckpoint: { lastPosition: giftCardPosition }
            });
          }

          // Check if we already have this gift card
          const existing = await pgStorage.getGiftCardBySquareId(giftCard.id);
          if (!existing) {
            // Convert to our model and save
            const card = squareClient.convertSquareGiftCardToGiftCard(giftCard);

            // Track count of zero vs non-zero amount cards
            if (card.amount > 0) {
              nonZeroAmountCards++;
            } else {
              zeroAmountCards++;
              console.log(`WARNING: Gift card ${giftCard.id} has zero amount`);
            }

            await pgStorage.createGiftCard(card);
            results.giftCards++;

            // Log every successful gift card insert
            console.log(`Successfully added gift card ${giftCard.id} with amount $${card.amount.toFixed(2)}`);
          } else if (existing.amount === 0) {
            // Try to update gift cards with zero amounts
            console.log(`Found existing gift card ${giftCard.id} with zero amount, attempting to update...`);
            const updatedCard = squareClient.convertSquareGiftCardToGiftCard(giftCard);

            if (updatedCard.amount > 0) {
              // Update the card with the new amount
              await db.update(giftCards)
                .set({ amount: updatedCard.amount, squareData: updatedCard.squareData })
                .where(eq(giftCards.squareId, giftCard.id));

              console.log(`UPDATED gift card ${giftCard.id} amount from $0 to $${updatedCard.amount.toFixed(2)}`);
              nonZeroAmountCards++;
            } else {
              zeroAmountCards++;
            }
          }
        } catch (giftCardError) {
          // Log the error but continue processing
          giftCardErrorCount++;
          console.error(`Error processing gift card at position ${i}:`, giftCardError);

          // Create a checkpoint so we don't lose progress
          if (i % 5 === 0) {
            await pgStorage.updateSyncState(giftCardsSyncState.id, {
              processedCount: i,
              lastSyncedAt: new Date(),
              lastCheckpoint: { lastPosition: i },
              errorMessage: `Skipped ${giftCardErrorCount} gift card records with errors`
            });
          }

          // Continue with next record
          continue;
        }
      }

      console.log(`Gift card sync complete: processed ${giftCardPosition} cards, encountered ${giftCardErrorCount} errors, added ${results.giftCards} new gift cards`);
      console.log(`Gift card amount summary: ${nonZeroAmountCards} cards with amounts > 0, ${zeroAmountCards} cards with zero amounts`);

      // Mark gift cards sync as complete
      await pgStorage.updateSyncState(giftCardsSyncState.id, {
        processedCount: giftCards.length,
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date()
      });

      // All sync operations complete
      const syncType = isInitialSync ? 'initial (90 days)' : 'incremental';
      console.log(`Unified ${syncType} sync complete. Added ${results.transactions} new transactions, processed ${results.orders} orders, added ${results.giftCards} new gift cards.`);

      // Release the lock
      isSyncRunning = false;

      res.json({
        success: true,
        message: `${isInitialSync ? 'Initial' : 'Incremental'} sync completed successfully`,
        syncType: isInitialSync ? 'initial' : 'incremental',
        results,
        lastSyncTime: new Date().toISOString(),
        timeWindow: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          totalDays: Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
        },
        giftCardSummary: {
          count: giftCardSalesCount,
          amount: giftCardSalesAmount
        }
      });
    } catch (error) {
      console.error("Error syncing with Square:", error);

      // Update sync state with error in database
      try {
        // Try to update all sync states
        const syncTypes = ['payments', 'orders', 'giftCards'];
        for (const syncType of syncTypes) {
          const syncState = await pgStorage.getSyncState(syncType);
          if (syncState) {
            await pgStorage.updateSyncState(syncState.id, {
              status: 'error',
              errorMessage: error instanceof Error ? error.message : "Unknown error",
              lastSyncedAt: new Date()
            });
          }
        }
      } catch (dbError) {
        console.error("Failed to update error state in database:", dbError);
      }

      // Release the lock even if there's an error
      isSyncRunning = false;

      res.status(500).json({
        success: false,
        error: "Failed to sync with Square",
        details: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Mount the API router
  app.use("/api", apiRouter);

  // Create and return HTTP server
  const httpServer = createServer(app);

  return httpServer;
}