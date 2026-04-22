import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Dedicated, tight limiter for the unauthenticated /api/health probe.
// It's allow-listed past requireAuth so an attacker can hit it without
// any credentials; pinning a small budget here keeps it from being a
// cheap signal-amplifier for log-noise generation or for shaving the
// global apiLimiter budget that legitimate authenticated endpoints
// share. 30/min is far above any real liveness probe cadence.
export const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many health checks, please try again later.' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

// Password-reset request limiter. Tighter than authLimiter because each
// successful request triggers an outbound email — we cannot let an
// attacker spam the inbox of a known account. 3 requests per IP per hour.
export const passwordResetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests, please try again later.' },
});

export const syncLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sync requests, please try again later.' },
});

// ---------------------------------------------------------------------------
// Per-route limiters for "hot" endpoints
// ---------------------------------------------------------------------------
// These run *in addition to* the global apiLimiter (100 req/min). They exist
// so a single client cannot spam the most expensive routes within the global
// budget — e.g. firing /summary in a tight loop is ~80x more work than
// firing /health 80 times. Limits were picked to comfortably fit normal
// dashboard polling cadence while leaving the burst headroom that an
// abusive client would need to do real damage.
//
// Normal client cadence (verified against client/src/* react-query hooks):
//   - /summary, /category-revenue, /hourly-revenue, /gift-card-summary,
//     /detailed-transactions  → fetched on view + every ~30-60s focus refetch
//   - /sync/status, /sync-progress → polled every ~5-10s while the sync UI
//     is open, otherwise idle
//   - /analyze-gift-cards → manual button, very rare
//   - /mcp → admin tool, low volume but each call may run a SQL query

// Factory that produces a fresh, route-scoped limiter instance.
// We deliberately create one limiter *per route* (rather than sharing a
// single limiter across many routes) because express-rate-limit's
// in-memory store is keyed only by client IP — sharing the same limiter
// instance would pool the budget across every endpoint that mounts it,
// effectively turning per-route limits into a group limit. With one
// instance per route, hitting /summary 30 times in a minute does not
// also lock the same client out of /hourly-revenue.
function makeLimiter(opts: { max: number; windowMs?: number; message?: string }) {
  return rateLimit({
    windowMs: opts.windowMs ?? 60 * 1000,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: opts.message ?? 'Too many requests, please try again later.' },
  });
}

// Heavy aggregation endpoints. All of these run multiple joined SQL
// aggregations over the orders / transactions / refunds tables. 30/min
// = 1 every 2s sustained, well above the ~2/min the dashboard actually
// fires per endpoint. One limiter instance per route so they don't share
// a bucket.
export const summaryLimiter = makeLimiter({ max: 30 });
export const categoryRevenueLimiter = makeLimiter({ max: 30 });
export const hourlyRevenueLimiter = makeLimiter({ max: 30 });
export const giftCardSummaryLimiter = makeLimiter({ max: 30 });
export const detailedTransactionsLimiter = makeLimiter({ max: 30 });

// Sync status / progress polling. Has to tolerate a UI polling every 5s
// while a long-running sync is visible (12/min), with headroom for two
// open tabs and a manual refresh.
export const syncProgressLimiter = makeLimiter({ max: 60 });
export const syncStatusLimiter = makeLimiter({ max: 60 });

// Gift-card analysis: scans every gift card row + cross-references orders,
// so it's the single most expensive read in the app. Manual button only —
// 10/min is generous.
export const analyzeGiftCardsLimiter = makeLimiter({ max: 10 });

// Gift-card "fix" endpoints. /fix-gift-cards rescans every unresolved
// card via the Square Activities API; /fix-gift-card/:id retries a
// single card. They're admin-only and sit behind syncLimiter for the
// bulk path, but each deserves its own per-route bucket so one card
// retry can't burn the bulk-fix budget (and vice versa).
export const fixGiftCardsLimiter = makeLimiter({
  max: 5,
  message: 'Too many gift card fix requests, please try again later.',
});
export const fixGiftCardSingleLimiter = makeLimiter({
  max: 20,
  message: 'Too many gift card fix requests, please try again later.',
});

// MCP JSON-RPC endpoint. Admin-only, but each request can drive a
// run_read_query call that pins a DB connection. 20/min is roughly one
// call every 3s — fine for an interactive admin session, tight enough
// that a stolen session can't blast the read replica.
export const mcpLimiter = makeLimiter({
  max: 20,
  message: 'Too many MCP requests, please try again later.',
});
