import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

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

// TOTP code-verification limiter for the login second-factor step.
// 6-digit TOTP codes are 1-in-1,000,000 per attempt. Combine that with
// 10 attempts / 15 min / IP and the brute-force expectation drops well
// below the 30-second TOTP window. The route also uses a per-session
// pending state with a short TTL so the practical attack window is
// much narrower than the rate-limit alone suggests.
export const totpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts, please try again later.' },
});

// Recovery-code regeneration limiters (Task #129). The
// /api/auth/totp/recovery-codes/regenerate endpoint requires both a
// current password AND a live authenticator code, but without
// throttling an attacker who has a stolen authenticated session can
// brute-force the password gate at full speed. We mirror the
// login/TOTP-verify shape (10 attempts per 15 min) and apply two
// independent buckets:
//   - per-IP: stops one host from hammering many accounts
//   - per-account: stops a botnet from spreading attempts across IPs
//     against a single victim account
// Both use skipSuccessfulRequests: true so a legitimate rotation
// doesn't count toward the bucket. The route additionally calls
// resetKey() on success so the next 15-minute window starts fresh
// after every confirmed-good rotation.
export const totpRecoveryRegenerateIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // Use express-rate-limit's ipKeyGenerator helper so IPv6 addresses are
  // bucketed by /64 prefix instead of by individual address — otherwise
  // a single IPv6 client would get a fresh limit per request because
  // their source address rotates within their assigned subnet.
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
  message: {
    error: 'Too many recovery code regeneration attempts, please try again later.',
  },
});

export const totpRecoveryRegenerateAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // requireAuth runs before this middleware on the regenerate route,
  // so req.user is set (typed via the global Express.Request and
  // express-session augmentations in server/middleware/auth.ts). The
  // IP fallback only fires for the impossible case where it isn't,
  // and prevents this middleware from throwing.
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? req.session?.userId;
    // IP fallback only fires for the impossible case where requireAuth
    // didn't set req.user; route through ipKeyGenerator so IPv6 clients
    // are bucketed by /64 subnet (see ipLimiter above for rationale).
    return userId != null
      ? `acct:${userId}`
      : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  message: {
    error: 'Too many recovery code regeneration attempts for this account, please try again later.',
  },
});

// Self-disable-2FA limiters (Task #174). The /api/auth/totp/disable
// endpoint sits behind requireAuth and only re-checks the current
// password — without throttling, an attacker holding a stolen
// authenticated session can brute-force the password gate at full
// speed and silently weaken the account's security posture by
// turning 2FA off. We mirror the recovery-code regenerate pattern
// (Task #129) exactly: same 10/15 min window, same dual per-IP +
// per-account buckets, same skipSuccessfulRequests, and the route
// also calls resetKey() on success so a legitimate disable doesn't
// poison the next-window budget for that IP/account.
//
// Why not share a single bucket with regenerate? They are different
// security postures (one rotates a recovery batch, the other turns
// the second factor off entirely) and an attacker who blows the
// regenerate budget should still face a fresh budget on disable —
// otherwise sharing would let one drained route shield the other
// from triggering its own throttle.
export const totpDisableIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // IPv6 clients are bucketed by /64 prefix via ipKeyGenerator (see
  // totpRecoveryRegenerateIpLimiter for the full rationale).
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
  message: {
    error: 'Too many disable attempts, please try again later.',
  },
});

export const totpDisableAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // requireAuth runs before this middleware on the disable route, so
  // req.user is set. The IP fallback only fires for the impossible
  // case where it isn't, and prevents this middleware from throwing.
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? req.session?.userId;
    return userId != null
      ? `acct:${userId}`
      : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  message: {
    error: 'Too many disable attempts for this account, please try again later.',
  },
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

// Recovery-email verification request limiter (Task #98). Same shape
// as passwordResetRequestLimiter — every successful call triggers an
// outbound email to a user-supplied address, so a loose limit would
// turn the endpoint into a free outbound-mail relay. 5 requests per
// IP per hour leaves room for legitimate retries (typo + correction +
// resend) while keeping abuse cheap to spot.
export const emailVerificationRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification email requests, please try again later.' },
});

// Confirm endpoint is unauthenticated (the link target is hit by
// whichever browser opens the email), so it needs its own brute-force
// cap on token guesses. The token is 256 bits of entropy — guessing
// is implausible — but the endpoint also gates a writable mutation,
// so we still cap it.
export const emailVerificationConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts, please try again later.' },
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
// Items-by-category dashboard tab (Task #188). Two panels render
// concurrently and the user flips category/metric quickly, so the
// budget is a touch higher than the standard aggregation limiter.
export const itemsCategoriesLimiter = makeLimiter({ max: 60 });
export const itemsRankedLimiter = makeLimiter({ max: 60 });

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
