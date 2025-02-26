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

  // Mount the API router
  app.use("/api", apiRouter);

  const httpServer = createServer(app);

  return httpServer;
}
