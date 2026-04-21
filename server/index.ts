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
import { toSafeErrorResponse, sendError, ForbiddenError } from "./errors";
import { isAllowedOrigin } from "./security/origin";
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_SECURE,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
} from "./sessionConfig";

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

// Production CSP: strict same-origin with no third-party allowances
// and no inline scripts / no eval.
const prodCspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // shadcn/Tailwind ship runtime styles inline.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  // Inter webfont files are bundled and served from same-origin.
  fontSrc: ["'self'", 'data:'],
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
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
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

// Cookie-name compatibility shim. When SESSION_COOKIE_NAME is the
// hardened `__Host-pg.sid` (i.e. anywhere outside an explicit
// development environment), browsers that signed in *before* this
// deploy will still be presenting the legacy `pg.sid` cookie. The
// session id itself is unchanged and remains valid in the
// connect-pg-simple `sessions` table — only the cookie *name* moved.
//
// Without this shim every previously-authenticated user would get
// silently logged out on deploy, violating the task's "Existing
// logins continue to work after deploy" requirement. Express-session
// reads from `req.headers.cookie` by name only, so we copy the
// legacy value over to the new name on the inbound request and let
// the rolling-session response set the cookie under the new
// hardened name. We also actively clear the stale legacy cookie so
// the browser stops sending two parallel session ids.
//
// This shim is a no-op once everyone has cycled onto the new name
// and can be deleted in a future pass; it costs one regex per
// request until then.
const LEGACY_SESSION_COOKIE_NAME = 'pg.sid';
if (SESSION_COOKIE_NAME !== LEGACY_SESSION_COOKIE_NAME) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cookieHeader = req.headers.cookie;
    if (
      cookieHeader &&
      !cookieHeader.includes(`${SESSION_COOKIE_NAME}=`) &&
      cookieHeader.includes(`${LEGACY_SESSION_COOKIE_NAME}=`)
    ) {
      const match = cookieHeader.match(/(?:^|;\s*)pg\.sid=([^;]+)/);
      if (match) {
        req.headers.cookie = `${cookieHeader}; ${SESSION_COOKIE_NAME}=${match[1]}`;
        // Tell the browser to drop the legacy cookie. We don't know
        // whether the original was Secure or not, but clearCookie
        // only needs the name + path to match for the browser to
        // expire it.
        res.clearCookie(LEGACY_SESSION_COOKIE_NAME, { path: '/' });
      }
    }
    next();
  });
}

app.use(session({
  store: new PgSession({
    pool: pool as any, // Type casting to avoid compatibility issues
    tableName: 'sessions', // Default table name
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  // Rolling sessions: every authenticated request resets the cookie
  // expiry, turning `cookie.maxAge` into an idle timeout. The
  // absolute upper bound is enforced by the middleware below.
  rolling: true,
  cookie: {
    maxAge: SESSION_IDLE_MS,
    secure: SESSION_COOKIE_SECURE,
    sameSite: 'lax',
    httpOnly: true,
    // `__Host-` cookies must have Path=/ and no Domain attribute.
    // We never set `domain` so the cookie stays bound to the exact
    // origin that issued it.
    path: '/',
  },
  name: SESSION_COOKIE_NAME,
}));

// Absolute session lifetime cap. `rolling: true` above keeps
// extending the cookie for active users, so without this an
// always-on tab could keep a session alive indefinitely. We stamp
// `createdAt` on the session at login time (see auth router) and
// destroy any session that exceeds SESSION_ABSOLUTE_MS regardless
// of activity, forcing periodic re-authentication.
app.use((req: Request, _res: Response, next: NextFunction) => {
  const sess: any = (req as any).session;
  if (sess && sess.userId) {
    // Backfill createdAt for sessions that pre-date this deploy so
    // the absolute cap eventually applies to them too. Without this,
    // legacy authenticated sessions would be exempt from the cap
    // until the user voluntarily logs out and back in.
    if (typeof sess.createdAt !== 'number') {
      sess.createdAt = Date.now();
    }
    if (Date.now() - sess.createdAt > SESSION_ABSOLUTE_MS) {
      sess.destroy((err: Error | null) => {
        if (err) {
          console.error('Error destroying expired session:', err);
        }
        // Leave it to the next request to issue a new (anonymous)
        // session cookie. Clearing here would require knowing the
        // exact cookie attributes (Secure, Path, name prefix); the
        // browser will simply receive no Set-Cookie this round and
        // the now-orphaned cookie will be rejected by the store.
        next();
      });
      return;
    }
  }
  next();
});

// ----------------------------------------------------------------------------
// CSRF defense (header check) — mounted BEFORE every router, including
// `/mcp`. Browsers cannot set a custom `x-requested-with` header on a
// cross-origin request without first satisfying CORS preflight, so
// requiring it on every state-changing request blocks classic
// form-POST CSRF. Applies to both `/api` and `/mcp` because `/mcp` is
// admin-only and a successful CSRF there can drive arbitrary tool
// calls (including run_read_query).
//
// `text/plain` POSTs (which the MCP JSON-RPC over Streamable HTTP uses
// when negotiated as text) do not trigger CORS preflight, so an
// attacker page on another origin could otherwise reach `/mcp` from a
// logged-in admin's browser. The MCP-specific block below adds a
// strict `Content-Type: application/json` requirement and an Origin
// allow-list check on top of the shared CSRF header check.
// NOTE: any new mutating router added outside `/api` or `/mcp` MUST
// be added to this list, otherwise it will not inherit CSRF
// protection. Keep this in sync with the actual route topology.
const CSRF_PROTECTED_PREFIXES = ['/api', '/mcp'];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use((req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (!CSRF_PROTECTED_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
    return next();
  }
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return sendError(res, new ForbiddenError('Forbidden: missing CSRF header'));
  }
  next();
});

// MCP-specific hardening. Runs in addition to (not instead of) the
// CSRF header check above.
//   - 415 if Content-Type is not strictly application/json. Blocks
//     the text/plain CSRF vector that bypasses CORS preflight.
//   - 403 if Origin is present and not on the same-origin /
//     ALLOWED_ORIGINS allow-list. GET/DELETE are also covered so a
//     cross-origin probe of an existing session id is rejected.
app.use('/mcp', (req, res, next) => {
  if (!isAllowedOrigin(req)) {
    return sendError(res, new ForbiddenError('Forbidden: disallowed Origin'));
  }
  // Strict Content-Type policy on every /mcp request that carries a
  // body. POST/PUT/PATCH must declare application/json. DELETE is
  // included: if the client sends a Content-Type at all, it must be
  // application/json (a body-less DELETE with no Content-Type header
  // is allowed and is what the MCP client actually sends). GET is
  // exempt because browsers never send Content-Type on GET.
  const ct = (req.headers['content-type'] || '').toString().split(';')[0].trim().toLowerCase();
  const requiresJson = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
  const ctIsBad = ct.length > 0 && ct !== 'application/json';
  if (requiresJson ? ct !== 'application/json' : ctIsBad) {
    res.status(415).json({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json',
      },
    });
    return;
  }
  next();
});

registerMcpRoutes(app);

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