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

import { type Express, type NextFunction } from "express";
import { createServer, type Server } from "http";
import { syncService } from "./services/syncService";
import { requireAuth, requireAdmin } from "./middleware/auth";
import { ConflictError, ValidationError } from "./errors";

// Import the router creators
import { createApiRouter, attachApiErrorMiddleware } from './routes/api';
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


  // Diagnostic endpoints `/test-square-connection` and `/test-orders-api` were
  // removed: they were unauthenticated-by-role debug relics that burned the
  // shared Square API rate-limit quota on every call and had no UI usage.

  // Historical backfill status — admin only, must be registered BEFORE the POST route
  apiRouter.get("/sync/backfill/status", requireAuth, requireAdmin, async (_req, res, next: NextFunction) => {
    try {
      const status = await syncService.getHistoricalBackfillStatus();
      res.json(status);
    } catch (err) {
      console.error('[BackfillStatus] Error:', err);
      next(err);
    }
  });

  // Historical backfill: syncs all orders + payments for a given date range in weekly chunks.
  // Params (body OR query string):
  //   startDate  — ISO date string, e.g. "2025-01-01"  (defaults to Jan 1 2025)
  //   endDate    — ISO date string, e.g. "2026-03-22"  (defaults to now)
  //   chunkDays  — number of days per chunk            (defaults to 7)
  // Returns immediately with 202 Accepted; poll GET /api/sync/backfill/status for progress.
  apiRouter.post("/sync/backfill", requireAuth, requireAdmin, async (req, res, next: NextFunction) => {
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
        throw new ValidationError('Invalid startDate or endDate');
      }
      if (start >= end) {
        throw new ValidationError('startDate must be before endDate');
      }

      console.log(`[Backfill] Received request: ${start.toISOString()} → ${end.toISOString()}, chunkDays=${chunk}`);
      const result = await syncService.startHistoricalOrdersPaymentsBackfill(start, end, chunk);

      if (result.alreadyRunning) {
        throw new ConflictError(result.message);
      }

      res.status(202).json({ success: true, message: result.message });
    } catch (err) {
      console.error('[Backfill] Error:', err);
      next(err);
    }
  });




  // Link gift cards to payment transactions - REMOVED (migrated to gift card service)
  
  // Update gift card activations endpoint - REMOVED (migrated to gift card service)

  // Update gift card amounts endpoint - REMOVED (migrated to gift card service)
  
  // Force update gift cards endpoint - REMOVED (migrated to gift card service)

  // Update gift card activations from transactions endpoint - REMOVED (migrated to gift card service)

  // All apiRouter routes have now been mounted (both the ones added inside
  // createApiRouter and the legacy backfill routes added directly above).
  // Attach the router-level error middleware now so it actually catches
  // next(err) from every route on the router.
  attachApiErrorMiddleware(apiRouter);

  // Register the API router
  // Mount our routers
  app.use("/api/auth", authRouter);
  app.use("/api", apiRouter);

  // Create HTTP server, attach WebSocket, and return it
  const httpServer = createServer(app);
  initWebSocket(httpServer);
  return httpServer;
}