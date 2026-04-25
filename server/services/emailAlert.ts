/**
 * In-process alerting for sustained outbound-email send failures
 * (Task #104).
 *
 * Mirrors `serverErrorAlert.ts`: a rolling window of recent failed
 * `sendEmail` calls, with a single Slack-compatible webhook fired
 * when the count crosses `threshold` and a cooldown to suppress
 * repeats. Aggregates by failure `reason` so the alert points at the
 * actual fault (Gmail 5xx vs. connector down vs. unconfigured) and
 * an on-call operator knows whether to reconnect Gmail, wait out a
 * Replit incident, or escalate to Google.
 *
 * Why in-process and not "wait for the log store"?
 *   The log shipper forwards to a hosted backend where operators can
 *   build their own alerts, but transactional email failures are
 *   individually painful (a real user is locked out of password
 *   reset). This module is the floor: even if the log backend is
 *   down or hasn't been wired yet, on-call still gets a webhook
 *   ping when reset emails start failing.
 *
 * Off by default — when `EMAIL_ALERT_WEBHOOK_URL` is unset (dev /
 * fresh deploy) the alerter is a silent no-op aside from keeping
 * its in-memory window. Defaults are tighter than the 5xx alerter
 * because each failed send is one locked-out user, not one HTTP
 * request the client can retry on its own.
 */

import { logger } from '../logger';

interface FailureEvent {
  ts: number;
  reason: string;
}

interface AlertConfig {
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

function loadEnvConfig(): AlertConfig {
  return {
    webhookUrl: process.env.EMAIL_ALERT_WEBHOOK_URL || null,
    // Three failures in fifteen minutes is still rare enough to be
    // worth waking someone over for password-reset traffic, while
    // tolerating the occasional Gmail blip without crying wolf.
    threshold: intFromEnv('EMAIL_ALERT_THRESHOLD', 3),
    windowMs: intFromEnv('EMAIL_ALERT_WINDOW_MS', 15 * 60 * 1000),
    cooldownMs: intFromEnv('EMAIL_ALERT_COOLDOWN_MS', 15 * 60 * 1000),
  };
}

type Notifier = (payload: { text: string }) => Promise<void>;

async function defaultNotifier(
  url: string,
  payload: { text: string },
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn('email_alert.webhook_failed', { status: res.status });
    }
  } catch (err) {
    logger.warn('email_alert.webhook_failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

class EmailAlerter {
  private events: FailureEvent[] = [];
  private lastAlertAt: number | null = null;
  private config: AlertConfig = loadEnvConfig();
  private notifier: Notifier | null = null;
  private now: () => number = () => Date.now();

  /** Test-only: override config / notifier / clock. */
  reconfigure(opts: {
    config?: Partial<AlertConfig>;
    notifier?: Notifier | null;
    now?: () => number;
  }): void {
    if (opts.config) this.config = { ...this.config, ...opts.config };
    if (opts.notifier !== undefined) this.notifier = opts.notifier;
    if (opts.now) this.now = opts.now;
  }

  /** Test-only: reset to env defaults. */
  reset(): void {
    this.events = [];
    this.lastAlertAt = null;
    this.config = loadEnvConfig();
    this.notifier = null;
    this.now = () => Date.now();
  }

  /**
   * Record one failed outbound email. `reason` is a short tag the
   * alerter aggregates by (e.g. `gmail_send_failed_403`,
   * `connector_failed`, `unconfigured`). Keep it bounded — it ends
   * up in the alert text — and never include recipient addresses or
   * any other PII.
   */
  record(reason: string): void {
    const t = this.now();
    this.events.push({ ts: t, reason });
    const cutoff = t - this.config.windowMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
    this.maybeFire(t);
  }

  private maybeFire(now: number): void {
    if (this.events.length < this.config.threshold) return;
    if (
      this.lastAlertAt !== null &&
      now - this.lastAlertAt < this.config.cooldownMs
    ) {
      return;
    }
    if (!this.config.webhookUrl && !this.notifier) return;

    this.lastAlertAt = now;

    // Aggregate by reason so the alert text tells the operator
    // *which* failure mode is in play, not just "lots of failures".
    const counts = new Map<string, number>();
    for (const e of this.events) {
      counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    }
    const breakdown = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    const windowMin = Math.round(this.config.windowMs / 60000);
    const text =
      `:email: Outbound email failing: ${this.events.length} ` +
      `failure${this.events.length === 1 ? '' : 's'} in the last ${windowMin}m — ${breakdown}`;

    const send =
      this.notifier ??
      ((p: { text: string }) => defaultNotifier(this.config.webhookUrl!, p));
    void send({ text });

    logger.warn('email_alert.fired', {
      count: this.events.length,
      source: 'emailAlert',
    });
  }
}

export const emailAlerter = new EmailAlerter();
