/**
 * Tests for the typed app_settings accessors (Task #97). The Square
 * 429 alert settings flow has its own integration test; this suite
 * pins the storage-layer behaviors that the typed registry adds:
 *
 *  - On read, a malformed/legacy row is logged and surfaces as
 *    `undefined` rather than reaching the consumer.
 *  - On write, an out-of-bounds payload is rejected before it touches
 *    the DB.
 *  - A round trip returns the validated, typed value.
 *
 * Vitest's default forks pool isolates module state per file.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { db } from '../db';
import {
  appSettings,
  SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
  type SquareRateLimitAlertSettings,
} from '@shared/schema';
import { pgStorage } from '../pgStorage';

const KEY = SQUARE_RATE_LIMIT_ALERT_SETTING_KEY;

async function clearKey(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, KEY));
}

describe('typed app_settings accessors (Task #97)', () => {
  beforeEach(clearKey);
  afterAll(clearKey);

  it('round-trips a valid value and returns the typed shape', async () => {
    const value: SquareRateLimitAlertSettings = {
      threshold: 12,
      windowMs: 5 * 60_000,
      cooldownMs: 7 * 60_000,
    };
    await pgStorage.setAppSetting(KEY, value);
    const out = await pgStorage.getAppSetting(KEY);
    expect(out).toEqual(value);
    // TypeScript would already flag this at compile time; the runtime
    // assertion just documents the contract.
    expect(typeof out?.threshold).toBe('number');
  });

  it('returns undefined when no row is persisted', async () => {
    const out = await pgStorage.getAppSetting(KEY);
    expect(out).toBeUndefined();
  });

  it('returns undefined when the persisted row fails schema validation', async () => {
    // Bypass the typed setter to write a deliberately bad row, the
    // way a stale schema or a migration bug could leave the table.
    await db
      .insert(appSettings)
      .values({ key: KEY, value: { threshold: 'not-a-number' } });

    const out = await pgStorage.getAppSetting(KEY);
    expect(out).toBeUndefined();

    // The bad row is left in place — the storage layer's job is to
    // refuse to surface it, not to mutate data behind the consumer's
    // back. A deliberate fix-up belongs in a migration, not a read.
    const stillThere = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, KEY));
    expect(stillThere).toHaveLength(1);
  });

  // Wiring check for Task #122. The alerter has its own unit-level
  // coverage in `appSettingsInvalidRowAlert.test.ts`; this test only
  // pins that `getAppSetting` actually invokes it on a malformed row.
  // Without this, a future refactor could quietly drop the
  // recordAppSettingsInvalidRowForAlerting call and the storage layer
  // would still pass its own tests because `undefined` is returned
  // either way — but on-call would never hear about the bad row.
  it('fires the invalid-row alerter when a persisted row fails schema validation', async () => {
    const { appSettingsInvalidRowAlerter } = await import(
      '../services/appSettingsInvalidRowAlert'
    );
    appSettingsInvalidRowAlerter.reset();
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
    });

    await db
      .insert(appSettings)
      .values({ key: KEY, value: { threshold: 'not-a-number' } });

    const out = await pgStorage.getAppSetting(KEY);
    expect(out).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(KEY);
    // The validation error message text comes through verbatim so
    // on-call sees exactly what the schema rejected, not a generic
    // "row is invalid" placeholder.
    expect(sent[0].text).toMatch(/threshold/);

    appSettingsInvalidRowAlerter.reset();
  });

  // Belt-and-braces: even if the alerter explodes (a future bug in
  // the notifier, a webhook URL parse error, etc.), the storage
  // layer's contract is still to return `undefined` on a malformed
  // row so consumers fall back to defaults. Losing an alert is
  // acceptable; poisoning every settings read with a rejected
  // promise is not.
  it('still returns undefined when the invalid-row alerter itself throws', async () => {
    const { appSettingsInvalidRowAlerter } = await import(
      '../services/appSettingsInvalidRowAlert'
    );
    appSettingsInvalidRowAlerter.reset();
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      // Synchronous throw inside record() would normally bubble out
      // of getAppSetting; we patch the singleton's record method so
      // the throw happens on the call path the storage layer uses,
      // not inside the async notifier (which is fire-and-forget and
      // wouldn't actually reach getAppSetting).
    });
    const original = appSettingsInvalidRowAlerter.record.bind(
      appSettingsInvalidRowAlerter,
    );
    appSettingsInvalidRowAlerter.record = () => {
      throw new Error('alerter exploded');
    };

    await db
      .insert(appSettings)
      .values({ key: KEY, value: { threshold: 'not-a-number' } });

    try {
      await expect(pgStorage.getAppSetting(KEY)).resolves.toBeUndefined();
    } finally {
      appSettingsInvalidRowAlerter.record = original;
      appSettingsInvalidRowAlerter.reset();
    }
  });

  it('rejects an out-of-bounds setter payload before writing to the DB', async () => {
    const bad = {
      threshold: 0, // schema min is 1
      windowMs: 1_000, // below 60_000 min
      cooldownMs: 1_000,
    } as unknown as SquareRateLimitAlertSettings;

    await expect(pgStorage.setAppSetting(KEY, bad)).rejects.toThrow();

    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, KEY));
    expect(rows).toHaveLength(0);
  });
});
