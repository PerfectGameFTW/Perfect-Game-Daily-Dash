import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { pgStorage } from "./pgStorage";
import { dateRangeSchema, InsertTransaction, InsertGiftCard } from "@shared/schema";
import { parse } from "date-fns";
import * as squareClient from "./squareClient";

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
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
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
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
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
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
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
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
      }
      
      const hourlyRevenue = await pgStorage.getHourlyRevenue(parsedDateRange.data, startDate, endDate);
      
      // Get gift card sales by hour for the same period to accurately split the revenue
      const giftCardSalesByHour = await pgStorage.getGiftCardSalesByHour(parsedDateRange.data, startDate, endDate);
      
      // Combine the regular hourly revenue with gift card data
      const enhancedHourlyRevenue = hourlyRevenue.map(hour => {
        // Find corresponding gift card sales for this hour, if any
        const giftCardData = giftCardSalesByHour.find(gc => gc.hour === hour.hour);
        const giftCardAmount = giftCardData ? giftCardData.amount : 0;
        
        // Calculate regular sales (total minus gift card sales)
        const regularSales = hour.amount - giftCardAmount;
        
        return {
          ...hour,
          regularSales: regularSales > 0 ? regularSales : 0,
          giftCardSales: giftCardAmount
        };
      });
      
      res.json(enhancedHourlyRevenue);
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
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
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
      } else {
        // Default to last 90 days if no dates specified
        const now = new Date();
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 90);
        endDate = now;
      }
      
      // Fetch payments from Square with date range
      const payments = await squareClient.fetchPayments(startDate, endDate);
      console.log(`Fetched ${payments.length} payments from Square for date range ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      // Process each payment and save to database
      for (const payment of payments) {
        // Check if we already have this transaction
        const existing = await pgStorage.getTransactionBySquareId(payment.id);
        if (!existing) {
          // Convert to our model and save
          const transaction = squareClient.convertSquarePaymentToTransaction(payment);
          await pgStorage.createTransaction(transaction);
          results.transactions++;
        }
      }
      
      // Fetch gift cards from Square
      const giftCards = await squareClient.fetchGiftCards();
      console.log(`Fetched ${giftCards.length} gift cards from Square`);
      
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
      
      console.log(`Sync complete. Added ${results.transactions} transactions and ${results.giftCards} gift cards.`);
      res.json({
        success: true,
        message: "Sync completed successfully",
        results
      });
    } catch (error) {
      console.error("Error syncing with Square:", error);
      res.status(500).json({ 
        success: false,
        error: "Failed to sync with Square" 
      });
    }
  });

  // Mount the API router
  app.use("/api", apiRouter);

  const httpServer = createServer(app);

  return httpServer;
}
