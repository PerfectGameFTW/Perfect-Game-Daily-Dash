import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import type { Server as HttpServer } from "http";
import { db, sql, pool, ensureMcpReadRole } from "./db";
import { closeWebSocket } from "./ws";
import { sessionMiddleware, legacyCookieCompatMiddleware } from "./session";
import { pgStorage } from "./pgStorage";
import { authService } from "./services/authService";
import { startScheduler } from "./services/schedulerService";
import { validateEnv } from "./validateEnv";
import { apiLimiter, mcpLimiter } from "./middleware/rateLimiter";
import { registerMcpRoutes } from "./mcp";
import { toSafeErrorResponse, sendError, ForbiddenError } from "./errors";
import { isAllowedOrigin } from "./security/origin";
import { SESSION_ABSOLUTE_MS } from "./sessionConfig";
import { logger, newRequestId, errorContext, setLogShipperSink } from "./logger";
import { logShipper } from "./services/logShipper";
import { serverErrorAlerter } from "./services/serverErrorAlert";

// Track the live HTTP server so the fatal-error shutdown routine can
// stop accepting new connections before the process exits. Populated
// once `server.listen()` is invoked below.
let httpServer: HttpServer | null = null;

// Graceful shutdown on fatal, non-recoverable errors.
//
// Per the Node docs, after `uncaughtException` the process is in an
// undefined state — open transactions, advisory locks, and other
// resource handles cannot be trusted. For a financial dashboard the
// only safe response is to stop accepting new work, give in-flight
// requests a brief grace period to finish, release the DB pool (which
// drops any held Postgres locks), and exit non-zero so Replit's
// supervisor restarts the workflow into a clean process.
//
// `unhandledRejection` is treated as equally fatal: a promise whose
// rejection nobody handled is, by definition, an unanticipated error
// path, and Node 15+ would itself exit by default. We route it
// through the same shutdown so cleanup is consistent either way.
const SHUTDOWN_GRACE_MS = 5000; // wait for in-flight requests
const SHUTDOWN_HARD_TIMEOUT_MS = 10000; // hard cap so a stuck close can't hang forever
let shuttingDown = false;

async function fatalShutdown(label: string, err: unknown): Promise<void> {
  if (shuttingDown) {
    // A second fatal during shutdown means cleanup itself is broken.
    // Skip straight to a hard exit so we don't get stuck in a loop.
    logger.error('shutdown.second_fatal', { label, ...errorContext(err) });
    process.exit(1);
  }
  shuttingDown = true;
  logger.error(`shutdown.${label}`, errorContext(err));

  // Hard cap: if any close hangs (a stuck DB query, a wedged socket),
  // force-exit so the supervisor can restart us.
  const hardTimer = setTimeout(() => {
    logger.error('shutdown.hard_timeout');
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS);
  hardTimer.unref();

  try {
    // 1. Stop accepting new HTTP connections. Existing requests get
    //    a short grace period to drain.
    if (httpServer) {
      await new Promise<void>((resolve) => {
        const drainTimer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        httpServer!.close(() => {
          clearTimeout(drainTimer);
          resolve();
        });
      });
    }

    // 2. Tear down the WebSocket server and terminate live clients
    //    so /ws subscribers see a clean disconnect.
    await closeWebSocket().catch((e) => {
      logger.error('shutdown.websocket_close_failed', errorContext(e));
    });

    // 3. Drain the Postgres pool. Ending the pool closes every
    //    connection, which in turn releases any session-scoped
    //    advisory locks or open transactions held by sync work.
    await pool.end().catch((e) => {
      logger.error('shutdown.pg_pool_end_failed', errorContext(e));
    });

    // 4. Best-effort flush of buffered remote logs so the shutdown
    //    breadcrumbs above (and any pre-crash error context) reach
    //    the log backend before the process exits.
    await logShipper.drain().catch(() => { /* shipper logs to stderr */ });
  } catch (cleanupErr) {
    logger.error('shutdown.cleanup_error', errorContext(cleanupErr));
  } finally {
    clearTimeout(hardTimer);
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  void fatalShutdown('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  void fatalShutdown('unhandledRejection', reason);
});

// ----------------------------------------------------------------------------
// NODE_ENV resolution (must run before validateEnv / app creation)
// ----------------------------------------------------------------------------
// Express defaults `app.get('env')` to 'development' whenever NODE_ENV
// is unset, and the dev/prod branch in this file (Vite middleware,
// strict CSP, HSTS, secure-cookie session config in server/session.ts,
// helmet via the `isProd` constant below) all key off either NODE_ENV
// or that derived setting. If a deployment ever boots without
// NODE_ENV, the process would silently fall into the dev branch:
// Vite's HMR middleware would be mounted, the loose dev CSP would be
// served, HSTS would be off, and the session cookie would lose its
// Secure attribute — a serious downgrade.
//
// We detect "production runtime" structurally rather than trusting
// the env var alone: the production build emits a bundled
// `dist/index.js` that this module is loaded from, while local dev
// runs `tsx server/index.ts`. If we're executing from the bundle,
// force NODE_ENV='production' (auto-coerce) and log the action so
// it's visible in deployment logs. Local dev (running the .ts source)
// is left untouched, so `npm run dev` continues to work without any
// env fiddling.
const runningFromBundle = import.meta.url.endsWith('/dist/index.js');
if (runningFromBundle && process.env.NODE_ENV !== 'production') {
  const before = process.env.NODE_ENV || 'unset';
  process.env.NODE_ENV = 'production';
  // `state` carries the prior value (allow-listed string) so the
  // coercion is auditable.
  logger.warn('startup.node_env_coerced', {
    nodeEnv: 'production',
    state: before,
  });
}
const RESOLVED_NODE_ENV = process.env.NODE_ENV ?? 'development';
logger.info('startup.env_resolved', { nodeEnv: RESOLVED_NODE_ENV });

validateEnv();

// Wire the structured logger to the optional remote shipper. When
// `LOG_SHIPPER_URL` is unset (dev / fresh deploy) `start()` is a
// no-op and `enqueue` short-circuits, so this costs nothing.
logShipper.start();
setLogShipperSink((line) => logShipper.enqueue(line));

const app = express();

// ----------------------------------------------------------------------------
// Trust proxy / client-IP topology
// ----------------------------------------------------------------------------
// Express derives `req.ip` (and the X-Forwarded-For chain consumed by
// express-rate-limit and the structured request logger) from the
// `trust proxy` setting. Getting this number wrong is a security
// issue:
//
//   - Set it too LOW (e.g. 0) and every client looks like it comes
//     from the proxy's IP. apiLimiter / authLimiter then rate-limit
//     the entire deployment as a single client, and our audit logs
//     record the wrong IP.
//   - Set it too HIGH (more hops than really exist) and an attacker
//     can spoof their X-Forwarded-For header — Express will trust
//     the spoofed value as the real client IP, bypassing per-IP
//     rate limits and poisoning audit trails.
//
// Today the deployment topology is exactly one trusted reverse proxy
// in front of this process (Replit's edge). Hence the default of `1`.
// If a future deployment adds another L7 hop (CDN, additional LB,
// etc.) the operator MUST bump TRUST_PROXY_HOPS to match the real
// number of trusted hops between the client and this Node process.
// Anything other than a non-negative integer is rejected so a typo
// in the env can't accidentally re-enable boolean `true` (which
// would trust ALL hops and is exactly the spoofing footgun above).
const TRUST_PROXY_HOPS_DEFAULT = 1;
const trustProxyRaw = process.env.TRUST_PROXY_HOPS;
let TRUST_PROXY_HOPS: number;
if (trustProxyRaw === undefined || trustProxyRaw === '') {
  TRUST_PROXY_HOPS = TRUST_PROXY_HOPS_DEFAULT;
} else {
  const parsed = Number(trustProxyRaw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.error('startup.invalid_trust_proxy_hops');
    process.exit(1);
  }
  TRUST_PROXY_HOPS = parsed;
}
app.set('trust proxy', TRUST_PROXY_HOPS);
logger.info('startup.trust_proxy', { trustProxyHops: TRUST_PROXY_HOPS });

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

// ----------------------------------------------------------------------------
// CORS — explicit deny
// ----------------------------------------------------------------------------
// This server is consumed only by its own first-party dashboard and
// MCP admin client, both of which run on the same origin. Browsers
// block cross-origin XHR/fetch by default, but we make that policy
// explicit here so:
//
//   1. The intent ("no cross-origin callers, ever") is visible in
//      code, not implicit in "we just never added a `cors()` line".
//   2. A future copy-paste of `cors()` somewhere downstream cannot
//      silently re-enable a permissive policy without removing this
//      block first.
//   3. Cross-origin requests from a non-allow-listed origin fail at
//      the CORS layer (403, no `Access-Control-Allow-Origin` header)
//      rather than only being caught by the CSRF / Origin checks
//      further down the stack.
//
// Same-origin browser traffic (no Origin header, or Origin === Host)
// is allowed through with NO `Access-Control-Allow-*` response
// headers, which is the correct posture: same-origin requests don't
// need them, and not emitting them prevents accidental relaxation.
// `ALLOWED_ORIGINS` (used by `isAllowedOrigin`) remains an escape
// hatch for reverse-proxy / preview deployments — those origins are
// also allowed through with no CORS response headers, on the
// assumption that the proxy terminates origin and forwards a
// matching Host.
//
// CSRF (`x-requested-with`) and the `/mcp` Origin allow-list still
// run after this middleware as defense-in-depth — this block is
// deliberately not their replacement.
app.use((req, res, next) => {
  // Browsers always send Origin on cross-origin requests and on
  // preflight. They omit it on top-level same-origin GETs and on
  // simple form posts, both of which are handled by other layers.
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    return next();
  }
  if (isAllowedOrigin(req)) {
    // Same-origin (or ALLOWED_ORIGINS escape hatch). Deliberately
    // do NOT echo the origin back via `Access-Control-Allow-Origin`:
    // a same-origin request does not need it, and not setting it
    // keeps the "no third-party callers" posture explicit.
    return next();
  }
  // Disallowed cross-origin. Short-circuit preflight and actual
  // requests with a 403 and no CORS headers so the browser fails
  // closed regardless of method.
  if (req.method === 'OPTIONS') {
    res.status(403).end();
    return;
  }
  return sendError(res, new ForbiddenError('Forbidden: cross-origin request denied'));
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/api', apiLimiter);
// /mcp gets the global apiLimiter PLUS a tighter mcpLimiter (20/min)
// because each MCP call may execute a SQL query against the read role.
app.use('/mcp', apiLimiter, mcpLimiter);

// Session middleware (shared with the WebSocket upgrade handler in
// server/ws.ts so /ws can authenticate the same session cookie).
// The legacy-cookie compat shim runs first so previously-issued
// `pg.sid` cookies are still recognised under the hardened
// `__Host-pg.sid` name. The full hardened session config (rolling,
// __Host- prefix, Secure, idle timeout, PG store) lives in
// server/session.ts.
app.use(legacyCookieCompatMiddleware);
app.use(sessionMiddleware);

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
          logger.error('session.destroy_failed', errorContext(err));
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

// Startup environment summary. Only allow-listed presence flags are logged
// — never the actual values of DATABASE_URL or other secrets.
logger.info('startup', {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  port: Number(process.env.PORT || 5000),
});

// Structured request logger. Captures only allow-listed fields:
//   { method, path, status, durationMs, requestId }
// Crucially, response bodies are NOT captured. The previous logger
// echoed the JSON response (truncated at 80 chars) for every /api
// path except /api/auth — that leaked customer names, payment notes,
// gift-card numbers, and other PII into Replit workspace logs.
//
// A request id is generated (or read from an inbound `x-request-id`
// header) and echoed back so the client can correlate failures with
// server-side logs without us having to log the payload.
app.use((req, res, next) => {
  const start = Date.now();
  const inbound = req.headers['x-request-id'];
  const requestId =
    typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
      ? inbound
      : newRequestId();
  res.setHeader('x-request-id', requestId);
  (req as any).requestId = requestId;

  res.on('finish', () => {
    if (!req.path.startsWith('/api')) return;
    // /api/health is an unauthenticated liveness probe with its own
    // tight rate limiter — logging every successful hit just produces
    // noise that dilutes the signal of actual API activity. We DO still
    // want to record 4xx/5xx (e.g. 429 from healthLimiter, 503 if the
    // app is degraded) so abuse and outage signals are preserved.
    // Strip a single trailing slash so /api/health and /api/health/
    // are treated identically (Express default routing matches both).
    const normalizedPath = req.path.endsWith('/') && req.path.length > 1
      ? req.path.slice(0, -1)
      : req.path;
    if (normalizedPath === '/api/health' && res.statusCode < 400) return;
    const ctx = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    };
    if (res.statusCode >= 500) {
      logger.error('request', ctx);
      // Feed the in-process 5xx alerter. This is independent of the
      // log shipper: even if the remote backend is down, on-call
      // still gets a webhook ping when the rate sustains over the
      // configured threshold/window.
      serverErrorAlerter.record(req.path, res.statusCode);
    } else if (res.statusCode >= 400) {
      logger.warn('request', ctx);
    } else {
      logger.info('request', ctx);
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

    // Generic per-deployment runtime settings (Task #94). Backs the
    // tunable Square 429 alert thresholds in the admin UI. Same
    // self-bootstrap pattern as mcp_query_audit so a freshly-deployed
    // environment without a `db:push` still serves the GET/PUT
    // endpoints instead of 500ing on a missing relation.
    log('Bootstrapping app settings schema...');
    await db.execute(sql`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    log('✓ App settings schema verified');

    // Recovery-email verification tokens (Task #98). Same self-bootstrap
    // pattern as the other tables in this block: schema lives in
    // shared/schema.ts and is the source of truth, but a freshly-deployed
    // environment without `npm run db:push` still gets the table so the
    // new self-service /me/email/* endpoints don't 500 on a missing
    // relation.
    log('Bootstrapping email verification tokens schema...');
    await db.execute(sql`CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens (user_id)`);
    log('✓ Email verification tokens schema verified');

    // Forced-rotation flag for users whose password predates the
    // strong-password policy (Task #55). Self-bootstrap pattern: in a
    // single DO block, add the column if missing and — only on that
    // first add — flip every existing user to mustRotatePassword=true
    // as the one-time backfill. Subsequent boots find the column and
    // skip the backfill, so the operation is idempotent and never
    // re-marks users who have already rotated.
    log('Bootstrapping must_rotate_password column...');
    await db.execute(sql`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'must_rotate_password'
      ) THEN
        ALTER TABLE users
          ADD COLUMN must_rotate_password BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE users SET must_rotate_password = TRUE;
      END IF;
    END$$;`);
    log('✓ must_rotate_password column verified');

    // Last-used-at timestamp for TOTP verification (Task #100). Self-
    // bootstraps the column when the deployment hasn't run db:push yet
    // so the admin Security overview can render "last used" without
    // 500ing on a missing column. Defaults to NULL — the next
    // successful TOTP/recovery verification stamps it.
    log('Bootstrapping totp_last_used_at column...');
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS totp_last_used_at TIMESTAMPTZ
    `);
    log('✓ totp_last_used_at column verified');

    // Append-only audit log of admin security actions (Task #100). Same
    // self-bootstrap pattern as mcp_query_audit so the new admin
    // endpoints don't 500 on a missing relation in environments that
    // haven't run db:push.
    log('Bootstrapping security audit log schema...');
    await db.execute(sql`CREATE TABLE IF NOT EXISTS security_audit_log (
      id SERIAL PRIMARY KEY,
      actor_user_id INTEGER,
      actor_ip TEXT,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_security_audit_log_created_at ON security_audit_log (created_at)`);
    log('✓ Security audit log schema verified');

    log('Registering routes...');
    const server = await registerRoutes(app);
    httpServer = server;
    log('✓ Routes registered successfully');

    // Error handling middleware — log full error server-side, return sanitized payload to client.
    // The sanitizer maps AppError subclasses to their own statusCode and
    // collapses everything else to a 500 with a generic message.
    app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      logger.error('unhandled_error', {
        requestId: (req as any).requestId,
        path: req.path,
        method: req.method,
        ...errorContext(err),
      });
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

      // Hydrate the in-process Square 429 alerter from any persisted
      // admin-tuned override. Failures are non-fatal: the alerter
      // already has working env-derived defaults loaded at module
      // init time, so a missing/unavailable DB just means the
      // override is ignored until the next boot.
      void (async () => {
        try {
          const { loadSquareRateLimitAlertOverride } = await import(
            './services/squareRateLimitAlertSettings'
          );
          await loadSquareRateLimitAlertOverride();
        } catch (err) {
          log(
            `[alerts] failed to hydrate rate-limit alert override: ${
              err instanceof Error ? err.message : String(err)
            }`,
            'error'
          );
        }
      })();
    });

  } catch (error) {
    await exitWithError(error);
  }
})();