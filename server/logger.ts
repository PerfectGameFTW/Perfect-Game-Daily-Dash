/**
 * Structured logger with explicit field allow-listing.
 *
 * Replit workspace logs are visible to anyone with workspace access, so the
 * logger must never emit raw upstream payloads (Square / Intercard responses,
 * request/response bodies, etc.) — those routinely contain PII like customer
 * names, payment notes, gift-card numbers, and email addresses.
 *
 * Every emitted line is a single JSON object with a fixed, allow-listed shape:
 *   { ts, level, msg, ...context }
 *
 * `context` is opt-in and is intentionally restricted to identifiers, counts,
 * durations, status codes, error codes, and short string tags. Callers are
 * expected to pre-extract the safe fields they want to log; the logger will
 * not introspect arbitrary objects.
 *
 * For 5xx error paths, errors are logged with `code`, `message`, and `stack`
 * so on-call engineers can still debug failures without leaking payloads.
 */
import { randomUUID } from 'crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Allow-listed context field names. Anything not in this set is dropped
// before serialization. This is the single source of truth for what the
// logger will ever write to stdout.
const ALLOWED_FIELDS = new Set<string>([
  // request context
  'requestId',
  'method',
  'path',
  'status',
  'durationMs',
  // domain identifiers (opaque IDs, never names/notes/emails)
  'syncType',
  'page',
  'pageCount',
  'count',
  'processed',
  'created',
  'updated',
  'failed',
  'matched',
  'errors',
  'orderId',
  'paymentId',
  'giftCardId',
  'transactionId',
  'refundId',
  'squareId',
  'userId',
  'cursor',
  // tags / state
  'source',
  'state',
  'category',
  'hitPageCap',
  'reason',
  'label',
  'event',
  'action',
  'phase',
  // sync / backfill operational counts
  'syncedCount',
  'scanned',
  'linked',
  'inserted',
  'cleared',
  'relinked',
  'redeemEvents',
  'cardsRefreshed',
  'budgetUsed',
  'budgetCap',
  'pagesUsed',
  'pagesProcessed',
  'pageNum',
  'chunkIndex',
  'chunkNumber',
  'totalChunks',
  'chunkDays',
  'chunkStart',
  'chunkEnd',
  'chunksCompleted',
  'chunksProcessed',
  'failedChunks',
  'budgetExceeded',
  'totalOrders',
  'totalPayments',
  'resweepTotal',
  // dates / windows
  'dateStr',
  'sinceDate',
  'startDate',
  'endDate',
  'currentDate',
  'lastDate',
  'daysProcessed',
  'failedDays',
  'consecutiveFailures',
  'elapsedMs',
  'elapsedMin',
  'staleMin',
  // gift card / order operational fields
  'total',
  'newCount',
  'existingCount',
  'updatedRows',
  'updatedLineItems',
  'updatedTransactions',
  'zeroed',
  'deletedCards',
  'fetchComplete',
  'callCount',
  'maxCalls',
  'orderCount',
  'eventCount',
  'finished',
  // misc identifiers / classification
  'rejectedReason',
  'name',
  'errorName',
  'errorType',
  // payout / activation backfill
  'payoutsProcessed',
  'entriesCreated',
  'filled',
  'corrected',
  'unresolved',
  // additional sync / scheduler scalar context
  'alreadyCorrect',
  'cap',
  'createdAt',
  'crossCheck',
  'events',
  'failedRefreshes',
  'fallback',
  'fetched',
  'httpStatus',
  'lastSyncedAt',
  'needingRepair',
  'overlapSec',
  'path',
  'raw',
  'since',
  'stuckMinutes',
  'subChunkDays',
  'subChunks',
  'subIndex',
  'totalSubs',
  'unique',
  'uniqueCards',
  'until',
  'upserted',
  'used',
  'viaOrderMatch',
  'watermark',
  'withoutActivation',
  'isResume',
  'remaining',
  'fallbackOk',
  'mismatch',
  'hasError',
  // intercard
  'mismatchTotal',
  'classifiedSum',
  'dbResolved',
  'fallbackAttempted',
  'fallbackOK',
  'fallbackFail',
  'bowling',
  'laserTag',
  'pureGC',
  // mcp audit
  'rowCount',
  'queryHash',
  'queryLen',
  'ip',
  // ws
  'ipCount',
  'userOpenCount',
  // rate context
  'limitMax',
  'windowMs',
  // user-lookup TTL cache instrumentation (Task #83). `cacheHit` is a
  // boolean tag emitted per requireAuth lookup; the count fields are
  // emitted by the periodic summary so an operator can see hit-rate
  // trend without grepping per-request lines.
  'cacheHit',
  'cacheHits',
  'cacheMisses',
  'cacheSize',
  'ttlMs',
  // 2FA / TOTP audit (Task #102). `factor` distinguishes a successful
  // login by authenticator code vs. consumed recovery code; `attemptCount`
  // is the running per-pending-session failure counter so an operator
  // grepping `auth.totp.login_failure` can see whether an account is
  // being hammered. `actorRole` records who initiated an admin-side
  // disable; `recoveryCodesRemaining` is the post-action count so the
  // operator can spot a near-empty batch.
  'factor',
  'attemptCount',
  'actorRole',
  'recoveryCodesRemaining',
  // error context
  'code',
  'errorMessage',
  'stack',
  // outbound-email audit (Task #104). `recipientHash` is a short
  // sha256 prefix of the recipient address — deterministic so repeat
  // failures to the same inbox aggregate visibly in the log without
  // putting the literal address on disk. `gmailMessageId` is the id
  // returned by Gmail's users.messages.send on a successful send so
  // operators can correlate with Gmail's own audit trail when a user
  // reports "I never got the email".
  'recipientHash',
  'gmailMessageId',
  // env summary — presence flags only, never values or var names
  'nodeEnv',
  'port',
  'hasDatabaseUrl',
  'hasIntercard',
  'trustProxyHops',
  // startup-only: a list of missing required env var names emitted on
  // the fatal-exit path so an operator knows what to set. The sanitizer
  // drops arrays by default, so this key has special handling below.
  'missing',
]);

export interface LogContext {
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
const MIN_LEVEL = LEVEL_RANK[envLevel] ?? LEVEL_RANK.info;

function sanitize(ctx?: LogContext): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ctx)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    const v = ctx[key];
    if (v === undefined) continue;
    // Coerce to a safe primitive shape. Strings are truncated to a
    // conservative cap so a misuse (e.g. passing a stack as `code`)
    // can't dump kilobytes of content into the log.
    if (typeof v === 'string') {
      out[key] = v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    } else if (
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      v === null
    ) {
      out[key] = v;
    } else if (
      key === 'missing' &&
      Array.isArray(v) &&
      v.every((x) => typeof x === 'string')
    ) {
      // Allow-listed: array of env-var names from the startup
      // missing-required path. Capped at 32 entries to bound the line
      // size if someone ever passes a runaway list.
      out[key] = (v as string[]).slice(0, 32);
    } else {
      // Drop arrays/objects entirely — callers should pre-extract counts
      // or IDs rather than handing a payload to the logger.
      // Exception: `errors` may be a number (count) only.
      continue;
    }
  }
  return out;
}

// Optional remote-shipping hook. Wired up by `server/index.ts` at
// startup via `setLogShipperSink(line => logShipper.enqueue(line))`.
// Keeping this as an opaque function (rather than importing the
// shipper module here) avoids a circular dependency: the shipper
// itself uses stderr for its own failure path so it never re-enters
// this logger.
type ShipperSink = (line: Record<string, unknown>) => void;
let shipperSink: ShipperSink | null = null;
export function setLogShipperSink(sink: ShipperSink | null): void {
  shipperSink = sink;
}

function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (LEVEL_RANK[level] < MIN_LEVEL) return;
  const safeCtx = sanitize(ctx);
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (safeCtx) Object.assign(line, safeCtx);
  // One JSON object per line. We deliberately go through the underlying
  // streams rather than `console.log` to avoid any future console
  // monkey-patching (e.g. by Vite's logger) reformatting the output.
  const out = JSON.stringify(line) + '\n';
  if (level === 'error' || level === 'warn') {
    process.stderr.write(out);
  } else {
    process.stdout.write(out);
  }
  // Forward the same allow-listed object to the remote shipper, if
  // any. The shipper enqueues synchronously and never throws — see
  // `server/services/logShipper.ts`.
  if (shipperSink) {
    try {
      shipperSink(line);
    } catch {
      // Defense-in-depth: a buggy shipper sink must never break local
      // logging.
    }
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
};

/**
 * Build the safe error context for a thrown value. Includes `code`
 * (when the error carries one), the message, and the stack so 5xx
 * failures remain debuggable without dumping the original payload.
 */
export function errorContext(err: unknown): LogContext {
  if (err instanceof Error) {
    const code = (err as any).code;
    return {
      errorMessage: err.message,
      stack: err.stack,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { errorMessage: String(err) };
}

export function newRequestId(): string {
  return randomUUID();
}
