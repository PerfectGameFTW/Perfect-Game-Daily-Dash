/**
 * Glue between the persisted `app_settings` row and the in-process
 * `squareRateLimitAlerter` singleton. Kept separate from the alerter
 * itself so the alerter has no dependency on the storage layer
 * (important for unit tests, which exercise the alerter directly
 * without standing up Postgres).
 *
 * Contract:
 *   - On boot, `loadSquareRateLimitAlertOverride` reads the persisted
 *     row (if any), validates it, and applies it to the alerter.
 *   - When an admin changes the thresholds in the UI, the route
 *     handler calls `applyAndPersistSquareRateLimitAlertOverride`
 *     which validates, persists to the DB, and pushes the new
 *     override into the live alerter so the change takes effect
 *     without a restart.
 */

import { pgStorage } from '../pgStorage';
import {
  SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
  type SquareRateLimitAlertSettings,
} from '@shared/schema';
import { logger } from '../logger';
import { squareRateLimitAlerter } from './squareRateLimitAlert';

export async function loadSquareRateLimitAlertOverride(): Promise<void> {
  // The typed registry-backed accessor returns the validated, narrowly
  // typed value (or undefined if absent / row is malformed). No
  // safeParse needed at this layer.
  const settings = await pgStorage.getAppSetting(
    SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
  );
  if (settings === undefined) return;
  squareRateLimitAlerter.setRuntimeOverride(settings);
  logger.info('square.rate_limit_alert_settings_loaded', {
    threshold: settings.threshold,
    windowMs: settings.windowMs,
    cooldownMs: settings.cooldownMs,
  });
}

export async function applyAndPersistSquareRateLimitAlertOverride(
  next: SquareRateLimitAlertSettings,
): Promise<void> {
  await pgStorage.setAppSetting(SQUARE_RATE_LIMIT_ALERT_SETTING_KEY, next);
  squareRateLimitAlerter.setRuntimeOverride(next);
  logger.info('square.rate_limit_alert_settings_updated', {
    threshold: next.threshold,
    windowMs: next.windowMs,
    cooldownMs: next.cooldownMs,
  });
}
