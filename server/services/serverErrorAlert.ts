/**
 * In-process alerting for sustained 5xx server-error rates.
 *
 * Mirrors `squareRateLimitAlert.ts`: a rolling window of recent 5xx
 * events, with a single Slack-compatible webhook fired when the count
 * crosses `threshold` and a cooldown to suppress repeats.
 *
 * Why in-process and not "wait for the log store"?
 *   The log shipper (`logShipper.ts`) forwards logs to a hosted
 *   backend, where operators can build their own alerts. This module
 *   is the floor: even if the log backend is down, slow, or hasn't
 *   been wired yet on a fresh deploy, on-call still gets a webhook
 *   ping when 5xx rate spikes. It owes nothing to the shipper.
 *
 * Off by default — when `SERVER_ERROR_ALERT_WEBHOOK_URL` is unset
 * (dev / fresh deploy) the alerter is a silent no-op aside from
 * keeping its in-memory window.
 */

import { logger } from '../logger';

interface ErrorEvent {
  ts: number;
  path: string;
  status: number;
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
    webhookUrl: process.env.SERVER_ERROR_ALERT_WEBHOOK_URL || null,
    threshold: intFromEnv('SERVER_ERROR_ALERT_THRESHOLD', 5),
    windowMs: intFromEnv('SERVER_ERROR_ALERT_WINDOW_MS', 5 * 60 * 1000),
    cooldownMs: intFromEnv('SERVER_ERROR_ALERT_COOLDOWN_MS', 15 * 60 * 1000),
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
      logger.warn('server_error_alert.webhook_failed', { status: res.status });
    }
  } catch (err) {
    logger.warn('server_error_alert.webhook_failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

class ServerErrorAlerter {
  private events: ErrorEvent[] = [];
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

  record(path: string, status: number): void {
    const t = this.now();
    this.events.push({ ts: t, path, status });
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

    // Aggregate by path so the alert points at the failing endpoint.
    const counts = new Map<string, number>();
    for (const e of this.events) {
      counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
    }
    const breakdown = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    const windowMin = Math.round(this.config.windowMs / 60000);
    const text =
      `:rotating_light: Server 5xx: ${this.events.length} ` +
      `event${this.events.length === 1 ? '' : 's'} in the last ${windowMin}m — ${breakdown}`;

    const send = this.notifier ?? ((p: { text: string }) =>
      defaultNotifier(this.config.webhookUrl!, p));
    void send({ text });

    logger.warn('server_error_alert.fired', {
      count: this.events.length,
      source: 'serverErrorAlert',
    });
  }
}

export const serverErrorAlerter = new ServerErrorAlerter();
