/**
 * In-process alerting for Square HTTP 429 (rate-limit) events.
 *
 * Why this lives here (and is not just a log-store alert rule):
 *   The team's log-forwarding / alerting pipeline is tracked separately and
 *   not yet in place. Until it is, on-call would only learn about Square
 *   throttling from an angry POS operator. This module bridges that gap by
 *   turning the existing `square.rate_limit_429` warnings into a real-time
 *   webhook alert (Slack-compatible incoming webhook) without depending on
 *   any external infra.
 *
 * Design:
 *   - A bounded rolling buffer of recent 429 events (timestamp + syncType +
 *     source) is kept in memory. Old events are evicted by timestamp on
 *     every record, so memory is O(events-in-window).
 *   - When the count of events in the window meets `threshold`, a single
 *     webhook POST is fired and a cooldown is started so we don't spam
 *     on-call during a sustained outage.
 *   - If `SQUARE_RATE_LIMIT_ALERT_WEBHOOK_URL` is unset (dev / tests), the
 *     module is a silent no-op aside from bookkeeping. The same env-gating
 *     also keeps unit tests from making outbound calls.
 *
 * Once the searchable log store + alert rules land, this module can be
 * removed in favor of a log-based alert; the structured `square.rate_limit_429`
 * event name is the contract that lets either path work.
 */

import { logger } from '../logger';

interface RateLimitEvent {
  ts: number;
  syncType: string;
  source: string;
}

export interface AlertConfig {
  webhookUrl: string | null;
  threshold: number;
  windowMs: number;
  cooldownMs: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadConfig(): AlertConfig {
  return {
    webhookUrl: process.env.SQUARE_RATE_LIMIT_ALERT_WEBHOOK_URL || null,
    threshold: intFromEnv('SQUARE_RATE_LIMIT_ALERT_THRESHOLD', 1),
    windowMs: intFromEnv('SQUARE_RATE_LIMIT_ALERT_WINDOW_MS', 5 * 60 * 1000),
    cooldownMs: intFromEnv('SQUARE_RATE_LIMIT_ALERT_COOLDOWN_MS', 15 * 60 * 1000),
  };
}

type Notifier = (payload: { text: string }) => Promise<void>;

async function defaultNotifier(url: string, payload: { text: string }): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn('square.rate_limit_alert_webhook_failed', {
        status: res.status,
      });
    }
  } catch (err) {
    logger.warn('square.rate_limit_alert_webhook_failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

class RateLimitAlerter {
  private events: RateLimitEvent[] = [];
  private lastAlertAt: number | null = null;
  private config: AlertConfig = loadConfig();
  private notifier: Notifier | null = null;
  private now: () => number = () => Date.now();

  /** Test-only: override config, notifier, and clock. */
  reconfigure(opts: {
    config?: Partial<AlertConfig>;
    notifier?: Notifier | null;
    now?: () => number;
  }): void {
    if (opts.config) this.config = { ...this.config, ...opts.config };
    if (opts.notifier !== undefined) this.notifier = opts.notifier;
    if (opts.now) this.now = opts.now;
  }

  /** Test-only: clear in-memory state. */
  reset(): void {
    this.events = [];
    this.lastAlertAt = null;
    this.config = loadConfig();
    this.notifier = null;
    this.now = () => Date.now();
  }

  record(syncType: string, source: string): void {
    const t = this.now();
    this.events.push({ ts: t, syncType, source });
    const cutoff = t - this.config.windowMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
    this.maybeFire(t);
  }

  private maybeFire(now: number): void {
    if (this.events.length < this.config.threshold) return;
    if (this.lastAlertAt !== null && now - this.lastAlertAt < this.config.cooldownMs) return;
    if (!this.config.webhookUrl && !this.notifier) return;

    this.lastAlertAt = now;

    // Aggregate by syncType+source so the alert tells on-call which path
    // is hot, not just that *something* is throttling.
    const counts = new Map<string, number>();
    for (const e of this.events) {
      const key = `${e.syncType}/${e.source}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const breakdown = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    const windowMin = Math.round(this.config.windowMs / 60000);
    const text =
      `:rotating_light: Square rate-limit (HTTP 429): ${this.events.length} ` +
      `event${this.events.length === 1 ? '' : 's'} in the last ${windowMin}m — ${breakdown}`;

    const send = this.notifier ?? ((p: { text: string }) =>
      defaultNotifier(this.config.webhookUrl!, p));

    // Fire-and-forget; webhook failures are logged inside the notifier.
    void send({ text });

    logger.warn('square.rate_limit_alert_fired', {
      count: this.events.length,
      source: 'squareRateLimitAlert',
    });
  }
}

export const squareRateLimitAlerter = new RateLimitAlerter();

/**
 * Hook called from `logIfSquare429` for every detected 429. Cheap and
 * synchronous; webhook delivery happens in the background.
 */
export function recordSquare429ForAlerting(syncType: string, source: string): void {
  squareRateLimitAlerter.record(syncType, source);
}
