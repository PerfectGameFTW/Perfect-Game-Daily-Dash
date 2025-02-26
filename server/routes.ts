import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { pgStorage, db } from "./pgStorage";
import { dateRangeSchema, InsertTransaction, InsertGiftCard, transactions } from "@shared/schema";
import { parse } from "date-fns";
import * as squareClient from "./squareClient";
import { and, gte, lte } from "drizzle-orm";

export async function registerRoutes(app: Express): Promise<Server> {
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
          
          console.log('Summary API - Parsed dates:', {
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString()
          });
        } catch (err) {
          console.error('Error parsing dates:', err);
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

  // Sync route to pull data from Square into our database
  apiRouter.post("/sync", async (req, res) => {
    try {
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
      
      // Process each payment and save to database
      let processedCount = 0;
      let existingCount = 0;
      
      for (const payment of payments) {
        processedCount++;
        if (processedCount % 50 === 0) {
          console.log(`Processing payment ${processedCount} of ${payments.length}...`);
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
      
      // Fetch ALL gift cards from Square (with pagination)
      const giftCards = await squareClient.fetchGiftCards();
      console.log(`Fetched ${giftCards.length} total gift cards from Square`);
      
      // Process each gift card and save to database
      for (const giftCard of giftCards) {
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
      res.json({
        success: true,
        message: "Sync completed successfully",
        results,
        timeWindow: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          totalDays: Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
        }
      });
    } catch (error) {
      console.error("Error syncing with Square:", error);
      res.status(500).json({ 
        success: false,
        error: "Failed to sync with Square" 
      });
    }
  });
  
  // Special route to sync data specifically for February 25, 2025
  apiRouter.post("/sync-feb25", async (req, res) => {
    try {
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
      await db.delete(transactions)
        .where(
          and(
            gte(transactions.timestamp, startDate),
            lte(transactions.timestamp, endDate)
          )
        );
      
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
      
      res.json({
        success: true,
        message: "Feb 25 sync completed successfully",
        stats: {
          totalTransactions: payments.length,
          totalAmount: totalAmount,
          statuses,
          date: "February 25, 2025"
        }
      });
    } catch (error) {
      console.error("Error syncing February 25 data:", error);
      res.status(500).json({ 
        success: false,
        error: "Failed to sync February 25 data" 
      });
    }
  });

  // Mount the API router
  app.use("/api", apiRouter);

  const httpServer = createServer(app);

  return httpServer;
}
