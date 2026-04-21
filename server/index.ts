import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { db, sql, pool } from "./db";
import { authService } from "./services/authService";
import { startScheduler } from "./services/schedulerService";
import { validateEnv } from "./validateEnv";
import { apiLimiter } from "./middleware/rateLimiter";
import { registerMcpRoutes } from "./mcp";

// Prevent unhandled async errors from crashing the process.
// Node.js 15+ exits by default on unhandledRejection — this keeps the server alive.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection (caught by global handler):', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (caught by global handler):', err);
});

validateEnv();

const app = express();
app.set('trust proxy', 1);
app.disable('etag');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/api', apiLimiter);
app.use('/mcp', apiLimiter);

// Configure session middleware
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool: pool as any, // Type casting to avoid compatibility issues
    tableName: 'sessions', // Default table name
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    httpOnly: true
  },
  name: 'pg.sid'
}));

registerMcpRoutes(app);

app.use('/api', (req, res, next) => {
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutatingMethods.includes(req.method) && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Forbidden: missing CSRF header' });
  }
  next();
});

// Add startup timestamp and environment check
const startTime = new Date().toISOString();
log(`Starting application at ${startTime}`);
log('Environment check:');
console.log({
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL ? '[PRESENT]' : '[MISSING]',
  PORT: process.env.PORT || 5000
});

// Add request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && !path.startsWith("/api/auth")) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

async function exitWithError(error: unknown) {
  log(`Fatal error during startup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
  log(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`, 'error');

  // Brief delay to ensure logs are flushed
  await new Promise(resolve => setTimeout(resolve, 1000));
  process.exit(1);
}

(async () => {
  try {
    // Verify database connection with detailed logging
    log('Verifying database connection...');
    try {
      await db.execute(sql`SELECT version()`);
      log('✓ Database connection verified');
      
      const usersExist = await authService.checkUsersExist();
      if (usersExist) {
        log('ℹ Users already exist');
      } else {
        log('ℹ No users exist — bootstrap the first admin out-of-band: `tsx scripts/bootstrap-admin.ts` (see replit.md)');
      }
    } catch (dbError) {
      log('✗ Database connection failed', 'error');
      throw dbError;
    }

    log('Creating database indexes if missing...');
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS intercard_revenue (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        location_id TEXT NOT NULL,
        device_type TEXT NOT NULL,
        device_name TEXT NOT NULL,
        cash_revenue REAL NOT NULL DEFAULT 0,
        credit_card_revenue REAL NOT NULL DEFAULT 0,
        cash_refunds REAL NOT NULL DEFAULT 0,
        credit_refunds REAL NOT NULL DEFAULT 0,
        other_payment REAL NOT NULL DEFAULT 0,
        customer_card_use REAL NOT NULL DEFAULT 0,
        revenue REAL NOT NULL DEFAULT 0,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_orders_square_id ON orders (square_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_transactions_square_id ON transactions (square_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_gift_cards_purchase_date ON gift_cards (purchase_date)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_gift_cards_square_id ON gift_cards (square_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds (created_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_refunds_square_refund_id ON refunds (square_refund_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_payout_fee_entries_effective_at ON payout_fee_entries (effective_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_order_line_items_order_id ON order_line_items (order_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sync_state_sync_type ON sync_state (sync_type)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_intercard_revenue_date ON intercard_revenue (date)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_orders_total_money_source ON orders (total_money, source)`);
      log('✓ Database indexes verified');
    } catch (indexError) {
      log(`⚠ Warning: Could not create indexes: ${indexError instanceof Error ? indexError.message : 'Unknown error'}`);
    }

    log('Registering routes...');
    const server = await registerRoutes(app);
    log('✓ Routes registered successfully');

    // Error handling middleware
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      log(`Error handler caught: ${err.message}`, 'error');
      if (!res.headersSent) {
        res.status(status).json({ message });
      }
    });

    // Vite setup with enhanced logging
    if (app.get("env") === "development") {
      log('Setting up Vite development server...');
      await setupVite(app, server);
      log('✓ Vite development server ready');
    } else {
      log('Setting up static file serving...');
      serveStatic(app);
      log('✓ Static file serving ready');
    }

    // Server startup with simplified configuration
    const port = 5000;
    server.listen({
      port,
      host: "0.0.0.0"
    }, () => {
      log(`✓ Server ready and listening on port ${port}`);
      // Start nightly sync scheduler (3 AM Eastern Time every day)
      startScheduler();
    });

  } catch (error) {
    await exitWithError(error);
  }
})();