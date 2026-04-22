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
  /** How long the rolling window must stay empty after an alert
   *  before we send the "all-clear" recovery message. */
  recoveryQuietPeriodMs: number;
}

/** Subset of `AlertConfig` admins can tune at runtime. The webhook
 *  URL is deliberately excluded — it's a credential and stays in env. */
export interface AlertTunableConfig {
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

function loadEnvBaseline(): AlertConfig {
  return {
    webhookUrl: process.env.SQUARE_RATE_LIMIT_ALERT_WEBHOOK_URL || null,
    threshold: intFromEnv('SQUARE_RATE_LIMIT_ALERT_THRESHOLD', 1),
    windowMs: intFromEnv('SQUARE_RATE_LIMIT_ALERT_WINDOW_MS', 5 * 60 * 1000),
    cooldownMs: intFromEnv('SQUARE_RATE_LIMIT_ALERT_COOLDOWN_MS', 15 * 60 * 1000),
    recoveryQuietPeriodMs: intFromEnv(
      'SQUARE_RATE_LIMIT_ALERT_RECOVERY_QUIET_MS',
      10 * 60 * 1000,
    ),
  };
}

type Notifier = (payload: { text: string }) => Promise<void>;

/** Schedules `cb` to run after `delayMs`. Returns a cancel function.
 *  Pluggable so unit tests can drive the recovery timer manually
 *  without resorting to real timers. */
export type RecoveryScheduler = (delayMs: number, cb: () => void) => () => void;

const defaultScheduler: RecoveryScheduler = (delayMs, cb) => {
  const h = setTimeout(cb, delayMs);
  // Don't keep the Node event loop alive solely for this watchdog.
  if (typeof (h as unknown as { unref?: () => void }).unref === 'function') {
    (h as unknown as { unref: () => void }).unref();
  }
  return () => clearTimeout(h);
};

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
  // Tracks whether we're currently inside an "alert episode" — i.e.
  // an alert has fired and we have not yet sent the matching recovery
  // notification. Used to gate the all-clear so we send exactly one
  // recovery per episode (no flapping).
  private episodeActive = false;
  private cancelRecoveryCheck: (() => void) | null = null;
  // `envBaseline` is the env-derived defaults (webhook URL + initial
  // threshold/window/cooldown). `runtimeOverride` is the admin-tuned
  // subset that takes precedence when present. Effective config is
  // `envBaseline` merged with `runtimeOverride` and is recomputed on
  // every `record()` so updates from `setRuntimeOverride()` apply
  // without restarting the server.
  private envBaseline: AlertConfig = loadEnvBaseline();
  private runtimeOverride: AlertTunableConfig | null = null;
  private notifier: Notifier | null = null;
  private now: () => number = () => Date.now();
  private scheduler: RecoveryScheduler = defaultScheduler;

  private effectiveConfig(): AlertConfig {
    const o = this.runtimeOverride;
    if (!o) return this.envBaseline;
    return {
      webhookUrl: this.envBaseline.webhookUrl,
      threshold: o.threshold,
      windowMs: o.windowMs,
      cooldownMs: o.cooldownMs,
      recoveryQuietPeriodMs: this.envBaseline.recoveryQuietPeriodMs,
    };
  }

  /** Returns a snapshot of the currently effective config. Used by
   *  the admin API to render the settings UI. */
  getEffectiveConfig(): AlertConfig {
    return this.effectiveConfig();
  }

  /** Returns just the admin-tunable subset of the effective config. */
  getTunable(): AlertTunableConfig {
    const c = this.effectiveConfig();
    return { threshold: c.threshold, windowMs: c.windowMs, cooldownMs: c.cooldownMs };
  }

  /** Apply (or clear) an admin-supplied override. Takes effect
   *  immediately on the next event recorded. Pass `null` to fall
   *  back to env defaults. */
  setRuntimeOverride(next: AlertTunableConfig | null): void {
    this.runtimeOverride = next;
    // Drop the cooldown timer when config changes so a freshly-tuned
    // threshold isn't masked by a stale cooldown from the previous
    // (potentially much-laxer) settings.
    this.lastAlertAt = null;
  }

  /** Test-only: override config, notifier, scheduler, and clock. */
  reconfigure(opts: {
    config?: Partial<AlertConfig>;
    notifier?: Notifier | null;
    now?: () => number;
    scheduler?: RecoveryScheduler;
  }): void {
    if (opts.config) this.envBaseline = { ...this.envBaseline, ...opts.config };
    if (opts.notifier !== undefined) this.notifier = opts.notifier;
    if (opts.now) this.now = opts.now;
    if (opts.scheduler) this.scheduler = opts.scheduler;
  }

  /** Test-only: clear in-memory state. */
  reset(): void {
    if (this.cancelRecoveryCheck) {
      this.cancelRecoveryCheck();
      this.cancelRecoveryCheck = null;
    }
    this.events = [];
    this.lastAlertAt = null;
    this.episodeActive = false;
    this.envBaseline = loadEnvBaseline();
    this.runtimeOverride = null;
    this.notifier = null;
    this.now = () => Date.now();
    this.scheduler = defaultScheduler;
  }

  record(syncType: string, source: string): void {
    const t = this.now();
    const cfg = this.effectiveConfig();
    this.events.push({ ts: t, syncType, source });
    const cutoff = t - cfg.windowMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
    this.maybeFire(t, cfg);
    // While an alert episode is in flight, every fresh 429 pushes the
    // recovery watchdog out: we only call "all-clear" once the rolling
    // window has been quiet for the configured period. The reschedule
    // also covers the case where `maybeFire` was suppressed by the
    // cooldown — the episode is still active, so the timer must keep
    // tracking the latest event.
    if (this.episodeActive) {
      this.scheduleRecoveryCheck(cfg);
    }
  }

  private scheduleRecoveryCheck(cfg: AlertConfig): void {
    if (this.cancelRecoveryCheck) this.cancelRecoveryCheck();
    this.cancelRecoveryCheck = this.scheduler(cfg.recoveryQuietPeriodMs, () => {
      this.cancelRecoveryCheck = null;
      this.fireRecovery();
    });
  }

  private fireRecovery(): void {
    if (!this.episodeActive) return;
    const cfg = this.effectiveConfig();
    const now = this.now();
    // Defensive: only declare recovery if the window really has been
    // empty for the full quiet period. If a late-arriving event slipped
    // in between the timer firing and us getting CPU time, push the
    // watchdog out instead of sending a premature all-clear.
    const cutoff = now - cfg.windowMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
    const mostRecent = this.events.length > 0
      ? this.events[this.events.length - 1].ts
      : null;
    if (mostRecent !== null && now - mostRecent < cfg.recoveryQuietPeriodMs) {
      const remaining = cfg.recoveryQuietPeriodMs - (now - mostRecent);
      this.cancelRecoveryCheck = this.scheduler(remaining, () => {
        this.cancelRecoveryCheck = null;
        this.fireRecovery();
      });
      return;
    }

    // One recovery message per episode — flip the flag *before*
    // dispatching so a re-entrant record() during send() can't trigger
    // a duplicate.
    this.episodeActive = false;

    if (!cfg.webhookUrl && !this.notifier) return;

    const quietMin = Math.round(cfg.recoveryQuietPeriodMs / 60000);
    const text =
      `:white_check_mark: Square rate-limit recovered: no HTTP 429s for ` +
      `${quietMin}m`;

    const send = this.notifier ?? ((p: { text: string }) =>
      defaultNotifier(cfg.webhookUrl!, p));

    void send({ text });

    logger.info('square.rate_limit_recovered', {
      source: 'squareRateLimitAlert',
    });
  }

  private maybeFire(now: number, cfg: AlertConfig): void {
    if (this.events.length < cfg.threshold) return;
    if (this.lastAlertAt !== null && now - this.lastAlertAt < cfg.cooldownMs) return;
    if (!cfg.webhookUrl && !this.notifier) return;

    this.lastAlertAt = now;
    // From this point we owe on-call exactly one matching "all-clear"
    // once traffic quiets down. `record()` keeps pushing the recovery
    // watchdog forward as long as new 429s arrive.
    this.episodeActive = true;
    this.scheduleRecoveryCheck(cfg);

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

    const windowMin = Math.round(cfg.windowMs / 60000);
    const text =
      `:rotating_light: Square rate-limit (HTTP 429): ${this.events.length} ` +
      `event${this.events.length === 1 ? '' : 's'} in the last ${windowMin}m — ${breakdown}`;

    const send = this.notifier ?? ((p: { text: string }) =>
      defaultNotifier(cfg.webhookUrl!, p));

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
