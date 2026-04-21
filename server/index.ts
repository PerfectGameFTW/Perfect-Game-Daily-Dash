import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { db, sql, pool, ensureMcpReadRole } from "./db";
import { pgStorage } from "./pgStorage";
import { authService } from "./services/authService";
import { startScheduler } from "./services/schedulerService";
import { validateEnv } from "./validateEnv";
import { apiLimiter } from "./middleware/rateLimiter";
import { registerMcpRoutes } from "./mcp";
import { toSafeErrorResponse } from "./errors";

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

// ----------------------------------------------------------------------------
// Security headers (helmet)
// ----------------------------------------------------------------------------
// Defense-in-depth headers for clickjacking, MIME-sniffing, and downgrade
// attacks. Configuration differs per environment because the Vite dev
// middleware injects inline scripts, opens an HMR WebSocket, and uses
// eval() for fast refresh — all of which a strict prod CSP must forbid.
//
// Both modes set:
//   - X-Content-Type-Options: nosniff
//   - X-Frame-Options: DENY  (also enforced via CSP frame-ancestors 'none')
//   - Referrer-Policy: no-referrer
//   - Cross-Origin-Opener-Policy / Resource-Policy: same-origin
// Production additionally sets:
//   - Strict-Transport-Security: max-age=1y; includeSubDomains; preload
//   - A tight Content-Security-Policy (no inline/eval, no third-party
//     origins). Same-origin /ws WebSocket is allowed via connect-src 'self'.
//
// HSTS is intentionally OFF in development so a local http://localhost
// session never gets pinned to https in the browser.
const isProd = process.env.NODE_ENV === 'production';

// Production CSP: strict same-origin with the bare minimum third-party
// allowances (Google Fonts) and no inline scripts / no eval.
const prodCspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // shadcn/Tailwind ship runtime styles, and client/index.html pulls
  // the Inter font stylesheet from fonts.googleapis.com.
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  // Inter webfont files are served from fonts.gstatic.com.
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  // Same-origin XHR + same-origin /ws WebSocket. 'self' covers both
  // http(s) and ws(s) on the same origin per CSP3.
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  upgradeInsecureRequests: [],
};

// Development CSP: permissive enough to keep Vite's HMR working
// (inline scripts/styles, eval-based fast refresh, the HMR WebSocket,
// blob: workers) while still defending against clickjacking and
// off-origin script injection. Same-origin only — no third-party
// scripts allowed even in dev.
const devCspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  // ws: covers Vite's HMR socket on http://localhost.
  connectSrc: ["'self'", 'ws:', 'wss:'],
  workerSrc: ["'self'", 'blob:'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  // Explicitly drop helmet's default `upgrade-insecure-requests` in
  // dev. On http://localhost it would force the browser to rewrite
  // ws:// HMR connections to wss:// (mixed-content "upgrade") and
  // break Vite's hot reload.
  upgradeInsecureRequests: null,
};

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: isProd ? prodCspDirectives : devCspDirectives,
    },
    strictTransportSecurity: isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    // X-Frame-Options is also covered by CSP frame-ancestors in prod, but
    // we keep the legacy header on for older browsers.
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false, // would block third-party images / Square assets
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  }),
);

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

    // Best-effort warm-up of the restricted MCP read-only role. The
    // request path also invokes ensureMcpReadRole() and will fail
    // closed if provisioning is not possible, so a startup failure
    // here (e.g. missing CREATEROLE on a managed Postgres) only logs
    // a warning and does not abort the server.
    ensureMcpReadRole().catch((err) => {
      log(
        `[mcp] warm-up of read-only role failed; run_read_query will be unavailable until resolved: ${(err as Error).message}`,
        'error'
      );
    });

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

    // Auth-recovery schema (users.email, uniq_users_email_lower,
    // password_reset_tokens) is now defined in shared/schema.ts and
    // applied via the standard `npm run db:push` flow. The startup
    // bootstrap that lived here was a workaround for Task #50 while
    // db:push was blocked on an interactive prompt — Task #62 fixed
    // that, so the workaround is gone. Add new schema objects to
    // shared/schema.ts instead of in this file.

    // MCP read-query audit log. Persists every `run_read_query` call so
    // admins can review who ran what query without shell access. This is
    // an idempotent self-bootstrap rather than a Drizzle migration so a
    // freshly-deployed environment that hasn't run `npm run db:push`
    // yet still gets the table the MCP audit middleware writes to. Once
    // every environment is on the post-Task-#54 schema, fold this into
    // shared/schema.ts the same way the auth-recovery block was.
    log('Bootstrapping MCP audit schema...');
    await db.execute(sql`CREATE TABLE IF NOT EXISTS mcp_query_audit (
      id SERIAL PRIMARY KEY,
      admin_user_id INTEGER,
      ip TEXT,
      query TEXT NOT NULL,
      row_count INTEGER,
      error TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_mcp_query_audit_created_at ON mcp_query_audit (created_at)`);
    log('✓ MCP audit schema verified');

    log('Registering routes...');
    const server = await registerRoutes(app);
    log('✓ Routes registered successfully');

    // Error handling middleware — log full error server-side, return sanitized payload to client.
    // The sanitizer maps AppError subclasses to their own statusCode and
    // collapses everything else to a 500 with a generic message.
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      log(`Error handler caught: ${err?.message ?? err}`, 'error');
      if (err?.stack) {
        log(err.stack, 'error');
      }
      if (!res.headersSent) {
        const { status, body } = toSafeErrorResponse(err);
        res.status(status).json(body);
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
      // Prune the MCP query audit log so it doesn't grow unbounded.
      // Runs once at boot and then daily; 90-day retention is plenty
      // for abuse investigations without bloating disk.
      const MCP_AUDIT_RETENTION_DAYS = 90;
      const pruneMcpAudit = () => {
        pgStorage
          .pruneMcpQueryAudit(MCP_AUDIT_RETENTION_DAYS)
          .then((deleted) => {
            if (deleted > 0) {
              log(`[mcp] pruned ${deleted} audit row(s) older than ${MCP_AUDIT_RETENTION_DAYS} days`);
            }
          })
          .catch((err) => {
            log(
              `[mcp] audit prune failed: ${err instanceof Error ? err.message : String(err)}`,
              'error'
            );
          });
      };
      pruneMcpAudit();
      setInterval(pruneMcpAudit, 24 * 60 * 60 * 1000).unref();
    });

  } catch (error) {
    await exitWithError(error);
  }
})();