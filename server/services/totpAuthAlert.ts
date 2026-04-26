/**
 * In-process alerting for TOTP-based brute-force and recovery-code
 * burst patterns (Task #132).
 *
 * Sister to `emailAlert.ts` / `serverErrorAlert.ts`: a rolling window
 * of recent TOTP-auth events with a Slack-compatible webhook fired
 * when one of two thresholds is crossed.
 *
 *   1. Login-failure brute force on the verify endpoint:
 *      `auth.totp.login_failure` lines now carry an `attemptCount`
 *      that the route layer increments per pending session
 *      (`server/routes/auth.ts`). The rate limiter caps total verify
 *      traffic per IP, but a stolen pending cookie or a botnet can
 *      still walk a single account up the attempt count under the
 *      cap. We fire when EITHER (a) the per-account failure count
 *      crosses `failureThreshold` inside `windowMs`, OR (b) any
 *      single event arrives with `attemptCount >= failureThreshold`
 *      — the latter catches the case where one pending session is
 *      being hammered and lets us alert without waiting for N
 *      separate logger lines to land.
 *
 *   2. Recovery-code burst on a single account: a normal
 *      recovery-code use is operationally interesting on its own
 *      (the user couldn't produce a TOTP code), but several uses
 *      against one account inside a short window is anomalous —
 *      either the recovery sheet leaked, or someone is walking the
 *      whole batch trying to find a hit before the user notices.
 *      We fire when the per-account recovery-code count crosses
 *      `recoveryThreshold` inside `windowMs`.
 *
 * Why in-process and not "wait for the log store":
 *   Same rationale as the other alerters in this directory — the
 *   log shipper forwards to a hosted backend where richer alerts can
 *   be built, but a 2FA brute force is the kind of incident a
 *   responder needs to see immediately. This module is the floor
 *   guarantee even when the backend is down or unwired.
 *
 * Off by default: when `TOTP_AUTH_ALERT_WEBHOOK_URL` is unset (dev
 * / fresh deploy) the alerter is a silent no-op aside from keeping
 * its in-memory window — same shape as the other Alert files.
 *
 * Per-account cooldown (not global): if account A is under attack
 * AND account B is independently under attack inside the same
 * cooldown window we want both alerts. A single global cooldown
 * would silence the second account, which is the exact case where
 * losing the alert hurts most (coordinated multi-account attack).
 * The bookkeeping is bounded by the number of accounts that have
 * crossed an alert threshold inside the cooldown window — small in
 * practice, and we additionally garbage-collect cooldown entries on
 * each record() so the maps cannot grow unbounded over a long
 * uptime.
 */

import { logger } from '../logger';

interface FailureEvent {
  ts: number;
  attemptCount: number;
}

interface RecoveryEvent {
  ts: number;
}

interface AlertConfig {
  webhookUrl: string | null;
  failureThreshold: number;
  recoveryThreshold: number;
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
    webhookUrl: process.env.TOTP_AUTH_ALERT_WEBHOOK_URL || null,
    // Five verify failures against one account in 15 minutes is well
    // above any realistic typo rate (the form rejects empty / non-6-
    // digit input client-side) and matches the per-account password
    // lockout threshold so the two defenses degrade together.
    failureThreshold: intFromEnv('TOTP_AUTH_ALERT_FAILURE_THRESHOLD', 5),
    // Recovery codes are strictly one-time: the user prints them
    // once at enrollment and most accounts never consume more than
    // one in their lifetime. Three uses on one account inside the
    // window is already strong evidence the sheet is compromised
    // (or being walked by an attacker). Default of 3 mirrors the
    // industry-standard "fewer than half a batch" red flag.
    recoveryThreshold: intFromEnv('TOTP_AUTH_ALERT_RECOVERY_THRESHOLD', 3),
    windowMs: intFromEnv('TOTP_AUTH_ALERT_WINDOW_MS', 15 * 60 * 1000),
    cooldownMs: intFromEnv('TOTP_AUTH_ALERT_COOLDOWN_MS', 60 * 60 * 1000),
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
      logger.warn('totp_auth_alert.webhook_failed', { status: res.status });
    }
  } catch (err) {
    logger.warn('totp_auth_alert.webhook_failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

class TotpAuthAlerter {
  private failures = new Map<number, FailureEvent[]>();
  private recoveries = new Map<number, RecoveryEvent[]>();
  private lastFailureAlertAt = new Map<number, number>();
  private lastRecoveryAlertAt = new Map<number, number>();
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

  /**
   * Read-only snapshot of the active config. The in-product alerts
   * panel (Task #177) uses these numbers as its default window /
   * threshold so it shows the same accounts the webhook would have
   * fired on, without re-loading the env vars at the route layer.
   * Returned by value so callers cannot mutate the live config.
   */
  getConfig(): Readonly<AlertConfig> {
    return { ...this.config };
  }

  /** Test-only: reset to env defaults. */
  reset(): void {
    this.failures.clear();
    this.recoveries.clear();
    this.lastFailureAlertAt.clear();
    this.lastRecoveryAlertAt.clear();
    this.config = loadEnvConfig();
    this.notifier = null;
    this.now = () => Date.now();
  }

  /**
   * Record a single `auth.totp.login_failure` event for `userId`.
   * `attemptCount` is the per-pending-session counter the route layer
   * stamps on the audit line — pass `null`/`undefined` if it was not
   * available so the alerter degrades gracefully.
   */
  recordLoginFailure(
    userId: number,
    attemptCount: number | null | undefined,
  ): void {
    const t = this.now();
    const ac = typeof attemptCount === 'number' ? attemptCount : 0;
    const list = this.failures.get(userId) ?? [];
    list.push({ ts: t, attemptCount: ac });
    this.purge(list, t);
    this.failures.set(userId, list);
    // Sweep map keys whose event arrays have aged out entirely so a
    // long-running deploy that has seen many one-off failures across
    // many distinct accounts does not accumulate empty entries
    // forever. We sweep here (and in recordRecoveryCodeUsed) instead
    // of on a timer so the work is amortized across normal traffic
    // and there is no separate scheduler to keep alive.
    this.gcEventMaps(t);
    this.gcCooldowns(t);
    this.maybeFireFailure(userId, list, t);
  }

  /**
   * Record a single `auth.totp.recovery_code_used` event for
   * `userId`. The route emits this on every successful recovery-code
   * consumption.
   */
  recordRecoveryCodeUsed(userId: number): void {
    const t = this.now();
    const list = this.recoveries.get(userId) ?? [];
    list.push({ ts: t });
    this.purge(list, t);
    this.recoveries.set(userId, list);
    this.gcEventMaps(t);
    this.gcCooldowns(t);
    this.maybeFireRecovery(userId, list, t);
  }

  private purge<T extends { ts: number }>(list: T[], now: number): void {
    const cutoff = now - this.config.windowMs;
    while (list.length > 0 && list[0].ts < cutoff) list.shift();
  }

  /**
   * Drop event-map keys whose rolling windows have fully aged out.
   * Without this, every distinct userId that has ever produced one
   * failure / recovery event leaves an empty array behind in the
   * map for the lifetime of the process. We re-purge each list (the
   * caller's purge only touched its own user) and delete keys whose
   * arrays are now empty.
   */
  private gcEventMaps(now: number): void {
    this.failures.forEach((list, k) => {
      this.purge(list, now);
      if (list.length === 0) this.failures.delete(k);
    });
    this.recoveries.forEach((list, k) => {
      this.purge(list, now);
      if (list.length === 0) this.recoveries.delete(k);
    });
  }

  /** Test-only: read map sizes so the lifecycle test can assert cleanup. */
  _debugSizes(): {
    failures: number;
    recoveries: number;
    failureCooldowns: number;
    recoveryCooldowns: number;
  } {
    return {
      failures: this.failures.size,
      recoveries: this.recoveries.size,
      failureCooldowns: this.lastFailureAlertAt.size,
      recoveryCooldowns: this.lastRecoveryAlertAt.size,
    };
  }

  /**
   * Drop cooldown entries that have fully expired so the maps cannot
   * grow without bound across long-running deploys. We keep entries
   * for one full cooldown past expiry as a small safety margin
   * against clock skew in `now()`.
   */
  private gcCooldowns(now: number): void {
    const cutoff = now - this.config.cooldownMs * 2;
    this.lastFailureAlertAt.forEach((v, k) => {
      if (v < cutoff) this.lastFailureAlertAt.delete(k);
    });
    this.lastRecoveryAlertAt.forEach((v, k) => {
      if (v < cutoff) this.lastRecoveryAlertAt.delete(k);
    });
  }

  private maybeFireFailure(
    userId: number,
    events: FailureEvent[],
    now: number,
  ): void {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    // Fire when EITHER (a) the rolling per-account count crosses
    // the threshold, OR (b) a single event reports an attemptCount
    // >= the threshold. The (b) case catches a single hammered
    // pending cookie that may otherwise produce only one log line
    // per request before being throttled.
    const triggered =
      events.length >= this.config.failureThreshold ||
      last.attemptCount >= this.config.failureThreshold;
    if (!triggered) return;
    if (this.inCooldown(this.lastFailureAlertAt.get(userId), now)) return;
    if (!this.config.webhookUrl && !this.notifier) return;

    this.lastFailureAlertAt.set(userId, now);
    const windowMin = Math.round(this.config.windowMs / 60000);
    const peakAttempt = events.reduce(
      (m, e) => (e.attemptCount > m ? e.attemptCount : m),
      0,
    );
    const text =
      `:lock: Suspected TOTP brute force on userId=${userId}: ` +
      `${events.length} verify failure${events.length === 1 ? '' : 's'} ` +
      `in the last ${windowMin}m (peak attemptCount=${peakAttempt})`;
    this.dispatch(text, 'totp_auth_alert.failure_fired', {
      userId,
      count: events.length,
      peakAttemptCount: peakAttempt,
    });
  }

  private maybeFireRecovery(
    userId: number,
    events: RecoveryEvent[],
    now: number,
  ): void {
    if (events.length < this.config.recoveryThreshold) return;
    if (this.inCooldown(this.lastRecoveryAlertAt.get(userId), now)) return;
    if (!this.config.webhookUrl && !this.notifier) return;

    this.lastRecoveryAlertAt.set(userId, now);
    const windowMin = Math.round(this.config.windowMs / 60000);
    const text =
      `:warning: Recovery-code burst on userId=${userId}: ` +
      `${events.length} code${events.length === 1 ? '' : 's'} ` +
      `consumed in the last ${windowMin}m`;
    this.dispatch(text, 'totp_auth_alert.recovery_fired', {
      userId,
      count: events.length,
    });
  }

  private inCooldown(lastAt: number | undefined, now: number): boolean {
    return lastAt !== undefined && now - lastAt < this.config.cooldownMs;
  }

  private dispatch(
    text: string,
    logKey: string,
    extra: Record<string, unknown>,
  ): void {
    const send =
      this.notifier ??
      ((p: { text: string }) => defaultNotifier(this.config.webhookUrl!, p));
    void send({ text });
    logger.warn(logKey, { ...extra, source: 'totpAuthAlert' });
  }
}

export const totpAuthAlerter = new TotpAuthAlerter();
