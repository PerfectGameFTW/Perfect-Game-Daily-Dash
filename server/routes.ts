import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { pgStorage, db } from "./pgStorage";
import { dateRangeSchema, InsertTransaction, InsertGiftCard, transactions } from "@shared/schema";
import { parse } from "date-fns";
import * as squareClient from "./squareClient";
import { and, gte, lte, sql } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {
  // Test route for gift card detection
  app.get('/api/test-gift-card-detection', async (req, res) => {
    try {
      // Fetch a few payments from Feb 25 to test gift card detection
      const startDate = new Date('2025-02-25T00:00:00.000Z');
      const endDate = new Date('2025-02-25T23:59:59.999Z');
      
      console.log("Fetching sample payments for gift card detection test...");
      const payments = await squareClient.fetchPayments(startDate, endDate);
      
      // Take first 10 payments only for testing
      const samplePayments = payments.slice(0, 10);
      
      // Test gift card detection
      const results = samplePayments.map(payment => {
        const transaction = squareClient.convertSquarePaymentToTransaction(payment);
        return {
          paymentId: payment.id,
          isGiftCard: transaction.categoryId === 'giftCard',
          category: transaction.categoryId,
          // Provide some data to help determine why it was/wasn't detected
          sourceType: payment.sourceType,
          cardDetails: payment.cardDetails ? {
            entryMethod: payment.cardDetails.entryMethod
          } : null,
          note: payment.note,
          // Include a portion of the payment data for inspection
          paymentSample: JSON.stringify(payment).substring(0, 500) + '...'
        };
      });
      
      res.json({
        success: true,
        totalPayments: payments.length,
        sampleSize: samplePayments.length,
        results
      });
    } catch (error) {
      console.error("Error testing gift card detection:", error);
      res.status(500).json({ 
        success: false,
        error: "Failed to test gift card detection" 
      });
    }
  });
  // Create API router for all endpoints
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
      
      const transactions = await pgStorage.getTransactions(parsedDateRange.data, startDate, endDate);
      
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
      
      // Get all transactions for the date range
      const allTransactions = await pgStorage.getTransactions(parsedDateRange.data, startDate, endDate);
      
      // Calculate transaction breakdowns
      // In a real implementation, we would have more accurate detection
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
        giftCardSales: allTransactions.filter(t => t.categoryId === 'giftCard')
          .reduce((sum, t) => sum + t.amount, 0)
      };
      
      res.json(detailedBreakdown);
    } catch (error) {
      console.error("Error getting detailed transaction breakdown:", error);
      res.status(500).json({ error: "Server error while getting detailed transaction data" });
    }
  });

  // Global variables for sync process
let isSyncRunning = false;
let lastSyncTime = new Date(0); // Initialize with epoch time
let syncProgress = {
  stage: 'idle', // 'idle', 'fetching', 'processing', 'gift-cards', 'complete'
  totalItems: 0,
  processedItems: 0,
  startTime: new Date(0),
  estimatedEndTime: null as Date | null,
  error: null as string | null
};

// Sync route to pull data from Square into our database
  apiRouter.post("/sync", async (req, res) => {
    try {
      // Check if a sync is already running
      if (isSyncRunning) {
        console.log("Sync already in progress. Skipping new sync request.");
        return res.status(409).json({ 
          success: false, 
          error: "A sync is already in progress. Please try again later.",
          lastSyncTime: lastSyncTime.toISOString()
        });
      }
      
      // Set the lock and initialize progress
      isSyncRunning = true;
      syncProgress = {
        stage: 'fetching',
        totalItems: 0,
        processedItems: 0,
        startTime: new Date(),
        estimatedEndTime: null,
        error: null
      };
      
      console.log("Starting sync with Square API...");
      const results = {
        transactions: 0,
        giftCards: 0
      };
      
      // Check Square API connection status
      const accessToken = process.env.SQUARE_ACCESS_TOKEN;
      const locationId = process.env.SQUARE_LOCATION_ID;
      
      if (!accessToken || !locationId) {
        console.error("Square API credentials are missing. Check environment variables.");
        return res.status(500).json({ 
          success: false,
          error: "Square API credentials are missing." 
        });
      }
      
      console.log("Using Square API with Location ID:", locationId);
      console.log("Using production Square API environment");
      
      // Get date parameters from request if provided
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (req.query.startDate && req.query.endDate) {
        startDate = new Date(req.query.startDate as string);
        endDate = new Date(req.query.endDate as string);
        console.log(`Using provided date range: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
      } else {
        // Default to last 90 days if no dates specified
        const now = new Date();
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 90);
        endDate = now;
        console.log(`Using default 90-day time window: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
      }
      
      // Fetch ALL payments from Square with date range (with pagination)
      const payments = await squareClient.fetchPayments(startDate, endDate);
      console.log(`Fetched ${payments.length} total payments from Square for date range: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
      
      // Update progress to processing stage
      syncProgress.stage = 'processing';
      syncProgress.totalItems = payments.length;
      syncProgress.processedItems = 0;
      
      // Process each payment and save to database
      let processedCount = 0;
      let existingCount = 0;
      
      for (const payment of payments) {
        processedCount++;
        // Update progress every 50 records
        if (processedCount % 50 === 0) {
          console.log(`Processing payment ${processedCount} of ${payments.length}...`);
          syncProgress.processedItems = processedCount;
          
          // Calculate estimated end time based on progress
          const elapsedMs = new Date().getTime() - syncProgress.startTime.getTime();
          const estimatedTotalMs = (elapsedMs / processedCount) * payments.length;
          syncProgress.estimatedEndTime = new Date(syncProgress.startTime.getTime() + estimatedTotalMs);
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
      }
      
      console.log(`Processed ${processedCount} payments, ${existingCount} already existed, added ${results.transactions} new transactions`);
      
      // Update progress to gift card stage
      syncProgress.stage = 'gift-cards';
      syncProgress.processedItems = payments.length;
      
      // Fetch ALL gift cards from Square (with pagination)
      const giftCards = await squareClient.fetchGiftCards();
      console.log(`Fetched ${giftCards.length} total gift cards from Square`);
      
      // Update progress for gift cards
      syncProgress.totalItems = payments.length + giftCards.length;
      
      // Process each gift card and save to database
      let giftCardCount = 0;
      for (const giftCard of giftCards) {
        giftCardCount++;
        
        // Update progress every 10 gift cards
        if (giftCardCount % 10 === 0) {
          console.log(`Processing gift card ${giftCardCount} of ${giftCards.length}...`);
          syncProgress.processedItems = payments.length + giftCardCount;
        }
        
        // Check if we already have this gift card
        const existing = await pgStorage.getGiftCardBySquareId(giftCard.id);
        if (!existing) {
          // Convert to our model and save
          const card = squareClient.convertSquareGiftCardToGiftCard(giftCard);
          await pgStorage.createGiftCard(card);
          results.giftCards++;
        }
      }
      
      console.log(`Sync complete. Added ${results.transactions} new transactions and ${results.giftCards} new gift cards.`);
      
      // Mark sync as complete
      syncProgress.stage = 'complete';
      syncProgress.processedItems = syncProgress.totalItems;
      
      // Update last sync time and release the lock
      lastSyncTime = new Date();
      isSyncRunning = false;
      
      res.json({
        success: true,
        message: "Sync completed successfully",
        results,
        lastSyncTime: lastSyncTime.toISOString(),
        timeWindow: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          totalDays: Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
        }
      });
    } catch (error) {
      console.error("Error syncing with Square:", error);
      
      // Update progress with error
      syncProgress.error = error instanceof Error ? error.message : "Unknown error";
      
      // Release the lock even if there's an error
      isSyncRunning = false;
      
      res.status(500).json({ 
        success: false,
        error: "Failed to sync with Square",
        details: syncProgress.error
      });
    }
  });
  
  // Special route to sync data specifically for February 25, 2025
  apiRouter.post("/sync-feb25", async (req, res) => {
    try {
      // Check if a sync is already running
      if (isSyncRunning) {
        console.log("Sync already in progress. Skipping Feb 25 sync request.");
        return res.status(409).json({ 
          success: false, 
          error: "A sync is already in progress. Please try again later.",
          lastSyncTime: lastSyncTime.toISOString()
        });
      }
      
      // Set the lock and initialize progress
      isSyncRunning = true;
      syncProgress = {
        stage: 'fetching',
        totalItems: 0,
        processedItems: 0,
        startTime: new Date(),
        estimatedEndTime: null,
        error: null
      };
      
      console.log("Starting specialized sync for February 25, 2025...");
      
      // Check Square API connection status
      const accessToken = process.env.SQUARE_ACCESS_TOKEN;
      const locationId = process.env.SQUARE_LOCATION_ID;
      
      if (!accessToken || !locationId) {
        console.error("Square API credentials are missing. Check environment variables.");
        return res.status(500).json({ 
          success: false,
          error: "Square API credentials are missing." 
        });
      }
      
      console.log("Using Square API with Location ID:", locationId);
      
      // Create specific date range for Feb 25, 2025 (from 00:00:00 to 23:59:59)
      const startDate = new Date('2025-02-25T00:00:00.000Z');
      const endDate = new Date('2025-02-25T23:59:59.999Z');
      
      console.log(`Syncing data for Feb 25, 2025: ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      // Fetch ALL payments for Feb 25, 2025 (with pagination)
      const payments = await squareClient.fetchPayments(startDate, endDate);
      console.log(`Fetched ${payments.length} total payments for Feb 25, 2025`);
      
      // Calculate total amount
      const totalAmount = payments.reduce((sum, payment) => {
        const amountMoney = payment.amountMoney;
        let amount = 0;
        
        if (amountMoney && amountMoney.amount !== undefined) {
          // Check if it's a BigInt and convert appropriately
          if (typeof amountMoney.amount === 'bigint') {
            amount = Number(amountMoney.amount) / 100;
          } else {
            // Regular number conversion
            amount = (Number(amountMoney.amount) || 0) / 100;
          }
        }
        
        return sum + amount;
      }, 0);
      
      // Count transactions by status
      const statuses = payments.reduce((acc, payment) => {
        const status = payment.status || 'unknown';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      // Process each payment and save to database (first clear existing records)
      console.log("Clearing existing Feb 25 transactions from database...");
      
      // This is a special case where we want to replace all Feb 25 data
      // First count existing transactions for Feb 25 in our database
      const existingCount = await db.select({ count: sql`count(*)` })
        .from(transactions)
        .where(
          and(
            gte(transactions.timestamp, startDate),
            lte(transactions.timestamp, endDate)
          )
        );
      
      const existingTotal = parseInt(existingCount[0]?.count?.toString() || '0');
      console.log(`Found ${existingTotal} existing transactions for Feb 25, 2025 in database`);
      
      // Then delete them all
      await db.delete(transactions)
        .where(
          and(
            gte(transactions.timestamp, startDate),
            lte(transactions.timestamp, endDate)
          )
        );
      
      console.log(`Deleted ${existingTotal} existing transactions for Feb 25, 2025`);
      
      console.log("Adding new Feb 25 transactions to database...");
      let addedCount = 0;
      
      for (const payment of payments) {
        // Convert to our model and save (no need to check for existing as we cleared them)
        const transaction = squareClient.convertSquarePaymentToTransaction(payment);
        await pgStorage.createTransaction(transaction);
        addedCount++;
        
        if (addedCount % 20 === 0) {
          console.log(`Added ${addedCount} of ${payments.length} transactions...`);
        }
      }
      
      console.log(`Feb 25 sync complete. Replaced with ${addedCount} transactions with total amount $${totalAmount.toFixed(2)}`);
      
      // Update last sync time and release the lock
      lastSyncTime = new Date();
      isSyncRunning = false;
      
      res.json({
        success: true,
        message: "Feb 25 sync completed successfully",
        lastSyncTime: lastSyncTime.toISOString(),
        stats: {
          totalTransactions: payments.length,
          totalAmount: totalAmount,
          statuses,
          date: "February 25, 2025"
        }
      });
    } catch (error) {
      console.error("Error syncing February 25 data:", error);
      
      // Release the lock even if there's an error
      isSyncRunning = false;
      
      res.status(500).json({ 
        success: false,
        error: "Failed to sync February 25 data" 
      });
    }
  });

  // Add a status endpoint to check the sync progress
  apiRouter.get("/sync-status", (req, res) => {
    res.json({
      isRunning: isSyncRunning,
      lastSyncTime: lastSyncTime.toISOString(),
      progress: syncProgress
    });
  });

  // Mount the API router
  app.use("/api", apiRouter);

  const httpServer = createServer(app);

  return httpServer;
}
