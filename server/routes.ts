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
      // Parse date range from query
      const dateRange = req.query.dateRange as string || "today";
      
      // Validate date range
      const parsedDateRange = dateRangeSchema.parse(dateRange);
      
      // Parse custom date range if needed
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (parsedDateRange === "custom") {
        if (!req.query.startDate || !req.query.endDate) {
          return res.status(400).json({ error: "Start date and end date are required for custom range" });
        }
        
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
      }
      
      // Get daily summary data
      const summary = await pgStorage.getDailySummary(parsedDateRange, startDate, endDate);
      
      res.json(summary);
    } catch (error) {
      console.error("Error getting summary:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Get transactions with date range filter
  apiRouter.get("/transactions", async (req, res) => {
    try {
      // Parse date range from query
      const dateRange = req.query.dateRange as string || "today";
      
      // Validate date range
      const parsedDateRange = dateRangeSchema.parse(dateRange);
      
      // Parse custom date range if needed
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (parsedDateRange === "custom") {
        if (!req.query.startDate || !req.query.endDate) {
          return res.status(400).json({ error: "Start date and end date are required for custom range" });
        }
        
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
      }
      
      const transactions = await pgStorage.getTransactions(parsedDateRange, startDate, endDate);
      
      res.json(transactions);
    } catch (error) {
      console.error("Error getting transactions:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Get revenue by category
  apiRouter.get("/revenue-by-category", async (req, res) => {
    try {
      // Parse date range from query
      const dateRange = req.query.dateRange as string || "today";
      
      // Validate date range
      const parsedDateRange = dateRangeSchema.parse(dateRange);
      
      // Parse custom date range if needed
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (parsedDateRange === "custom") {
        if (!req.query.startDate || !req.query.endDate) {
          return res.status(400).json({ error: "Start date and end date are required for custom range" });
        }
        
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
      }
      
      const categoryRevenue = await pgStorage.getCategoryRevenue(parsedDateRange, startDate, endDate);
      
      res.json(categoryRevenue);
    } catch (error) {
      console.error("Error getting category revenue:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Get hourly revenue
  apiRouter.get("/hourly-revenue", async (req, res) => {
    try {
      // Parse date range from query
      const dateRange = req.query.dateRange as string || "today";
      
      // Validate date range
      const parsedDateRange = dateRangeSchema.parse(dateRange);
      
      // Parse custom date range if needed
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (parsedDateRange === "custom") {
        if (!req.query.startDate || !req.query.endDate) {
          return res.status(400).json({ error: "Start date and end date are required for custom range" });
        }
        
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
      }
      
      const hourlyRevenue = await pgStorage.getHourlyRevenue(parsedDateRange, startDate, endDate);
      
      res.json(hourlyRevenue);
    } catch (error) {
      console.error("Error getting hourly revenue:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Get gift card summary
  apiRouter.get("/gift-card-summary", async (req, res) => {
    try {
      // Parse date range from query
      const dateRange = req.query.dateRange as string || "today";
      
      // Validate date range
      const parsedDateRange = dateRangeSchema.parse(dateRange);
      
      // Parse custom date range if needed
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (parsedDateRange === "custom") {
        if (!req.query.startDate || !req.query.endDate) {
          return res.status(400).json({ error: "Start date and end date are required for custom range" });
        }
        
        startDate = parse(req.query.startDate as string, "yyyy-MM-dd", new Date());
        endDate = parse(req.query.endDate as string, "yyyy-MM-dd", new Date());
      }
      
      const giftCardSummary = await pgStorage.getGiftCardSummary(parsedDateRange, startDate, endDate);
      
      res.json(giftCardSummary);
    } catch (error) {
      console.error("Error getting gift card summary:", error);
      res.status(400).json({ error: "Invalid request" });
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
      
      // Fetch payments from Square
      const payments = await squareClient.fetchPayments();
      console.log(`Fetched ${payments.length} payments from Square`);
      
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
      res.status(500).json({ error: "Failed to sync with Square" });
    }
  });

  // Mount the API router
  app.use("/api", apiRouter);

  const httpServer = createServer(app);

  return httpServer;
}
