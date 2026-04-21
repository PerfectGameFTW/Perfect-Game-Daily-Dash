import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
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

// Heavy aggregation endpoints. All of these run multiple joined SQL
// aggregations over the orders / transactions / refunds tables. 30/min
// = 1 every 2s sustained, well above the ~2/min the dashboard actually
// fires per endpoint.
export const heavyReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Sync status / progress polling. Has to tolerate a UI polling every 5s
// while a long-running sync is visible (12/min), with headroom for two
// open tabs and a manual refresh.
export const statusPollLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Gift-card analysis: scans every gift card row + cross-references orders,
// so it's the single most expensive read in the app. Manual button only —
// 10/min is generous.
export const analysisLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// MCP JSON-RPC endpoint. Admin-only, but each request can drive a
// run_read_query call that pins a DB connection. 20/min is roughly one
// call every 3s — fine for an interactive admin session, tight enough
// that a stolen session can't blast the read replica.
export const mcpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many MCP requests, please try again later.' },
});
