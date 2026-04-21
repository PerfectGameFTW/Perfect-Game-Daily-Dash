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

import { type Express } from "express";
import { createServer, type Server } from "http";
import * as squareClient from "./squareClient";
const squareSDK = squareClient.squareClient;
import { syncService } from "./services/syncService";
import { requireAuth, requireAdmin } from "./middleware/auth";

// Import the router creators
import { createApiRouter } from './routes/api';
import { createAuthRouter } from './routes/auth';
import { initWebSocket } from './ws';

export async function registerRoutes(app: Express): Promise<Server> {
  // Create the routers using our service-based implementation
  const apiRouter = createApiRouter();
  const authRouter = createAuthRouter();
  
  // Legacy API routes below will be gradually migrated to the new service-based implementation


  // Legacy duplicates of /summary, /transactions, /revenue-by-category,
  // /hourly-revenue, /gift-card-summary, and /detailed-transactions were
  // removed; the canonical service-based implementations live in
  // server/routes/api.ts.


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