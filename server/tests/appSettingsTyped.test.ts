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
