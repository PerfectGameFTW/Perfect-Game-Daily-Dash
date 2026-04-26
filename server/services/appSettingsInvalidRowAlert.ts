/**
 * In-process alerting for `app_settings` rows that fail schema
 * validation on read (Task #122).
 *
 * Why this exists:
 *   `pgStorage.getAppSetting` re-validates each persisted row against
 *   the schema in `appSettingsRegistry`. When a row no longer matches
 *   the registered shape — typically because of a code change without
 *   a matching migration, or a hand-edited prod row — the storage
 *   layer logs `app_settings.invalid_row` and quietly returns
 *   `undefined` so the consumer falls back to defaults. That keeps
 *   the app running, but it also means a misconfigured production
 *   setting can silently revert with nobody noticing until an
 *   incident. This module turns the same event into a real operator
 *   alert via the existing webhook channel.
 *
 * Design (mirrors `squareRateLimitAlert.ts` / `serverErrorAlert.ts`):
 *   - Per-key cooldown so the same broken row being polled by every
 *     request doesn't spam on-call. Default 1 hour — by design,
 *     because an invalid app_settings row stays invalid until a
 *     human deploys a fix, so high-frequency repeats add no
 *     information.
 *   - Off by default: when `APP_SETTINGS_INVALID_ROW_ALERT_WEBHOOK_URL`
 *     is unset (dev / fresh deploy / tests) the module is a silent
 *     no-op aside from the per-key timestamp bookkeeping. The same
 *     env-gating keeps unit tests from making outbound calls.
 *
 * Runbook (intentional duplicate of the comment in `pgStorage.ts` so
 * an on-call who lands here from the alert payload also sees it):
 *
 *   When you receive an `app_settings invalid row` alert, do NOT
 *   "fix" the row by editing it in psql. Treat it as a code/data
 *   mismatch and ship a one-off migration that either:
 *     - rewrites the row to the new shape (if the schema change
 *       was intentional and the field can be defaulted), or
 *     - deletes the row entirely (the consumer will fall back to
 *       defaults, which is what's already happening implicitly).
 *   Hand edits in production leave no audit trail and are exactly
 *   what produced this alert in the first place.
 */

import { logger } from '../logger';

interface AlertConfig {
  webhookUrl: string | null;
  /** Per-key cooldown in ms. The same broken row alerts at most
   *  once per cooldown — see the design note above for why this
   *  defaults to 1 hour rather than the few-minute cooldowns the
   *  Square 429 / 5xx alerters use. */
  cooldownMs: number;
}

interface ValidationIssue {
  path: string;
  message: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadEnvConfig(): AlertConfig {
  return {
    webhookUrl: process.env.APP_SETTINGS_INVALID_ROW_ALERT_WEBHOOK_URL || null,
    cooldownMs: intFromEnv(
      'APP_SETTINGS_INVALID_ROW_ALERT_COOLDOWN_MS',
      60 * 60 * 1000,
    ),
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
      logger.warn('app_settings_invalid_row_alert.webhook_failed', {
        status: res.status,
      });
    }
  } catch (err) {
    logger.warn('app_settings_invalid_row_alert.webhook_failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

class AppSettingsInvalidRowAlerter {
  private lastAlertAtByKey = new Map<string, number>();
  private config: AlertConfig = loadEnvConfig();
  private notifier: Notifier | null = null;
  private now: () => number = () => Date.now();

  /** Test-only accessor: whether a per-key cooldown timestamp is
   *  currently set. Used by the storage-layer recovery test to
   *  assert the cooldown was actually cleared on a successful read,
   *  without exposing the private map. */
  hasCooldownFor(key: string): boolean {
    return this.lastAlertAtByKey.has(key);
  }

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

  /** Test-only: reset to env defaults and clear cooldown state. */
  reset(): void {
    this.lastAlertAtByKey.clear();
    this.config = loadEnvConfig();
    this.notifier = null;
    this.now = () => Date.now();
  }

  /**
   * Called from `pgStorage.getAppSetting` for every row that fails
   * its registered schema. Cheap and synchronous; webhook delivery
   * happens in the background. Per-key cooldown enforced inside.
   */
  record(key: string, issues: ValidationIssue[]): void {
    const t = this.now();
    const last = this.lastAlertAtByKey.get(key);
    if (last !== undefined && t - last < this.config.cooldownMs) return;
    if (!this.config.webhookUrl && !this.notifier) return;

    // Mark the cooldown BEFORE dispatching so a re-entrant record()
    // during the (async) send cannot trigger a duplicate.
    this.lastAlertAtByKey.set(key, t);

    // Cap issues in the message so a pathological schema with a
    // hundred sub-issues can't blow up a Slack post.
    const MAX_ISSUES_IN_TEXT = 5;
    const shown = issues.slice(0, MAX_ISSUES_IN_TEXT);
    const overflow = issues.length - shown.length;
    const issueLines = shown
      .map((i) => `  • ${i.path || '(root)'}: ${i.message}`)
      .join('\n');
    const overflowLine = overflow > 0 ? `\n  • …and ${overflow} more` : '';

    const text =
      `:warning: app_settings row "${key}" failed schema validation on read.\n` +
      `${issueLines}${overflowLine}\n` +
      `The consumer is now falling back to defaults — fix or delete the row ` +
      `via a one-off migration (never hand-edit app_settings in prod).`;

    const send = this.notifier ?? ((p: { text: string }) =>
      defaultNotifier(this.config.webhookUrl!, p));

    // Fire-and-forget; webhook failures are logged inside the notifier.
    void send({ text });

    logger.warn('app_settings.invalid_row_alert.fired', {
      key,
      issueCount: issues.length,
      source: 'appSettingsInvalidRowAlert',
    });
  }

  /**
   * Called from `pgStorage.getAppSetting` whenever a row reads back
   * cleanly (Task #168). If we previously alerted on this key, clear
   * the per-key cooldown so the next break re-alerts immediately
   * instead of being silently swallowed by a leftover quiet window
   * — the row is materially healthy now, and the next failure is a
   * new incident worth paging on. Mirrors the recovery quiet-period
   * pattern in `squareRateLimitAlert.ts`, scoped per key here
   * because each app_settings row is its own independent failure
   * domain.
   *
   * If no prior alert fired for this key, this is a no-op so a
   * settings page that polls happy keys all day doesn't fire
   * spurious "recovered" pings.
   */
  recordRecovery(key: string): void {
    if (!this.lastAlertAtByKey.has(key)) return;
    this.lastAlertAtByKey.delete(key);

    if (!this.config.webhookUrl && !this.notifier) {
      // Cooldown still gets cleared above so that a webhook
      // configured *after* the row recovers will alert on the next
      // genuine break — same contract as `record()` when nothing
      // was sent.
      logger.info('app_settings.invalid_row_recovered', {
        key,
        source: 'appSettingsInvalidRowAlert',
        webhookConfigured: false,
      });
      return;
    }

    const text =
      `:white_check_mark: app_settings row "${key}" now passes schema ` +
      `validation again. The next invalid-row break for this key will ` +
      `re-alert immediately.`;

    const send = this.notifier ?? ((p: { text: string }) =>
      defaultNotifier(this.config.webhookUrl!, p));

    void send({ text });

    logger.info('app_settings.invalid_row_recovered', {
      key,
      source: 'appSettingsInvalidRowAlert',
      webhookConfigured: true,
    });
  }
}

export const appSettingsInvalidRowAlerter = new AppSettingsInvalidRowAlerter();

/** Public hook called from `pgStorage.getAppSetting`. */
export function recordAppSettingsInvalidRowForAlerting(
  key: string,
  issues: ValidationIssue[],
): void {
  appSettingsInvalidRowAlerter.record(key, issues);
}

/**
 * Public hook called from `pgStorage.getAppSetting`'s success branch
 * (Task #168). Clears the per-key cooldown if a prior alert fired so
 * a re-break after an admin fix-up migration pages on-call
 * immediately rather than waiting out the original quiet window.
 */
export function recordAppSettingsRecoveryForAlerting(key: string): void {
  appSettingsInvalidRowAlerter.recordRecovery(key);
}
