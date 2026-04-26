/**
 * Tests for the admin "App settings registry" panel surface (Task #167).
 * Splits cleanly into:
 *
 *   1. Unit-level coverage of `pgStorage.validateAllAppSettings()`:
 *      every registered key is reported, the status reflects what's
 *      actually persisted, invalid rows expose the same zod issue
 *      list the alerter sends, and — critically — the validation
 *      pass does NOT fire the invalid-row alerter (Task #122). The
 *      alerter is sized for the live read path; an admin polling
 *      the panel must not be able to re-arm or duplicate alerts.
 *
 *   2. Integration coverage of `GET /api/admin/app-settings/validation`:
 *      admin-only auth posture, response shape, and that a re-fetch
 *      after a hand-fixed row reflects the new state (the panel's
 *      whole point).
 *
 * Vitest's default forks pool isolates module state per file, so the
 * process-global `appSettingsInvalidRowAlerter` mutated here does not
 * leak into the other suites that touch it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import {
  users,
  appSettings,
  appSettingsRegistry,
  SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
  REQUIRE_ADMIN_2FA_SETTING_KEY,
} from '@shared/schema';
import { authService } from '../services/authService';
import { createApiRouter } from '../routes/api';
import { pgStorage } from '../pgStorage';
import { appSettingsInvalidRowAlerter } from '../services/appSettingsInvalidRowAlert';

const REGISTERED_KEYS = Object.keys(appSettingsRegistry);

async function clearRegisteredRows(): Promise<void> {
  await db.delete(appSettings).where(inArray(appSettings.key, REGISTERED_KEYS));
}

describe('pgStorage.validateAllAppSettings (Task #167)', () => {
  beforeEach(async () => {
    await clearRegisteredRows();
    appSettingsInvalidRowAlerter.reset();
  });

  afterAll(async () => {
    await clearRegisteredRows();
    appSettingsInvalidRowAlerter.reset();
  });

  it('reports every registered key, with `missing` when no row is persisted', async () => {
    const entries = await pgStorage.validateAllAppSettings();
    const reported = entries.map((e) => e.key).sort();
    expect(reported).toEqual([...REGISTERED_KEYS].sort());
    for (const e of entries) {
      expect(e.status).toBe('missing');
      expect(e.issues).toEqual([]);
      expect(e.updatedAt).toBeNull();
      // validatedAt should always be a parseable timestamp, even
      // for missing rows.
      expect(Number.isFinite(new Date(e.validatedAt).getTime())).toBe(true);
    }
  });

  it('reports `valid` with the row updatedAt when the persisted row matches the schema', async () => {
    await pgStorage.setAppSetting(SQUARE_RATE_LIMIT_ALERT_SETTING_KEY, {
      threshold: 5,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });

    const entries = await pgStorage.validateAllAppSettings();
    const sq = entries.find((e) => e.key === SQUARE_RATE_LIMIT_ALERT_SETTING_KEY);
    expect(sq).toBeDefined();
    expect(sq!.status).toBe('valid');
    expect(sq!.issues).toEqual([]);
    expect(sq!.updatedAt).not.toBeNull();
    expect(Number.isFinite(new Date(sq!.updatedAt!).getTime())).toBe(true);

    // Other registered keys remain `missing` — the validation pass
    // is per-key, not all-or-nothing.
    const other = entries.find((e) => e.key === REQUIRE_ADMIN_2FA_SETTING_KEY);
    expect(other?.status).toBe('missing');
  });

  it('reports `invalid` with the same zod issue list the alerter would send', async () => {
    // Bypass the typed setter to write a deliberately bad row, the
    // way a stale schema or migration bug could leave the table.
    await db.insert(appSettings).values({
      key: SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
      value: { threshold: 'not-a-number' },
    });

    const entries = await pgStorage.validateAllAppSettings();
    const sq = entries.find((e) => e.key === SQUARE_RATE_LIMIT_ALERT_SETTING_KEY);
    expect(sq).toBeDefined();
    expect(sq!.status).toBe('invalid');
    expect(sq!.issues.length).toBeGreaterThan(0);
    // The first issue is on the `threshold` path — this is the same
    // detail the on-call alert payload contains, so an admin reading
    // the panel sees the same diagnostic the on-call would.
    expect(sq!.issues.some((i) => i.path === 'threshold')).toBe(true);
    for (const issue of sq!.issues) {
      expect(typeof issue.message).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('does NOT fire the invalid-row alerter when an admin polls the panel', async () => {
    // Wiring guard for the design contract in
    // server/services/appSettingsInvalidRowAlert.ts: per-key cooldown
    // is sized for live reads. An admin pulling the panel must never
    // be able to push the alerter into firing again.
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
    });

    await db.insert(appSettings).values({
      key: SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
      value: { threshold: 'not-a-number' },
    });

    // Three back-to-back panel polls — should produce zero alerts.
    await pgStorage.validateAllAppSettings();
    await pgStorage.validateAllAppSettings();
    await pgStorage.validateAllAppSettings();

    expect(sent).toHaveLength(0);
  });

  it('re-running the validation after a fix-up returns the new status', async () => {
    // Seed a broken row, confirm it shows invalid, then write a
    // valid one and re-validate — the panel's "Refresh" workflow.
    await db.insert(appSettings).values({
      key: SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
      value: { threshold: 'not-a-number' },
    });

    const before = await pgStorage.validateAllAppSettings();
    expect(
      before.find((e) => e.key === SQUARE_RATE_LIMIT_ALERT_SETTING_KEY)?.status,
    ).toBe('invalid');

    await pgStorage.setAppSetting(SQUARE_RATE_LIMIT_ALERT_SETTING_KEY, {
      threshold: 3,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });

    const after = await pgStorage.validateAllAppSettings();
    const sq = after.find((e) => e.key === SQUARE_RATE_LIMIT_ALERT_SETTING_KEY);
    expect(sq?.status).toBe('valid');
    expect(sq?.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration coverage
// ---------------------------------------------------------------------------

const TEST_ADMIN_USERNAME = '__appsettings_panel_admin__';
const TEST_USER_USERNAME = '__appsettings_panel_user__';
const STRONG_PASSWORD = 'Str0ng!Panel-Test-9z';

interface TestSession {
  userId?: number;
  destroy: (cb?: (err?: Error) => void) => void;
}

interface RequestWithTestSession extends Request {
  session: TestSession;
}

type JsonBody = Record<string, unknown> | string;

interface JsonResp {
  status: number;
  headers: Headers;
  body: JsonBody;
}

function parseJsonBody(text: string): JsonBody {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<JsonResp> {
  const r = await fetch(url, { headers });
  return { status: r.status, headers: r.headers, body: parseJsonBody(await r.text()) };
}

function asObject(body: JsonBody): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Expected JSON object response, got: ${String(body)}`);
  }
  return body;
}

describe('GET /api/admin/app-settings/validation (Task #167)', () => {
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let userId: number;

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, TEST_ADMIN_USERNAME));
    await db.delete(users).where(eq(users.username, TEST_USER_USERNAME));

    const admin = await authService.registerUser(TEST_ADMIN_USERNAME, STRONG_PASSWORD, 'admin');
    adminId = admin.id;
    const user = await authService.registerUser(TEST_USER_USERNAME, STRONG_PASSWORD, 'user');
    userId = user.id;

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());

    // Same test session shim the rate-limit settings test uses:
    // pick the identity per request via an x-test-user-id header.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const asUserId = req.headers['x-test-user-id'];
      const session: TestSession = {
        destroy: (cb) => { if (cb) cb(); },
      };
      if (typeof asUserId === 'string' && asUserId !== '') {
        session.userId = Number(asUserId);
      }
      (req as RequestWithTestSession).session = session;
      next();
    });

    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clearRegisteredRows();
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(async () => {
    await clearRegisteredRows();
    authService.invalidateUserCache?.(adminId);
    authService.invalidateUserCache?.(userId);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const r = await getJson(`${baseUrl}/api/admin/app-settings/validation`);
    expect(r.status).toBe(401);
  });

  it('rejects non-admin requests with 403', async () => {
    const r = await getJson(`${baseUrl}/api/admin/app-settings/validation`, {
      'x-test-user-id': String(userId),
    });
    expect(r.status).toBe(403);
  });

  it('returns one entry per registered key with the correct shape and no-store cache header', async () => {
    const r = await getJson(`${baseUrl}/api/admin/app-settings/validation`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = asObject(r.body);
    expect(typeof body.validatedAt).toBe('string');
    const entries = body.entries as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((e) => e.key).sort()).toEqual([...REGISTERED_KEYS].sort());
    for (const entry of entries) {
      expect(['valid', 'invalid', 'missing']).toContain(entry.status);
      expect(Array.isArray(entry.issues)).toBe(true);
    }
  });

  it('surfaces an invalid row with its zod issue list, then reflects the fix on a second GET', async () => {
    // Plant a broken row directly so we can verify the panel sees it.
    await db.insert(appSettings).values({
      key: SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
      value: { threshold: 'not-a-number' },
    });

    const before = await getJson(`${baseUrl}/api/admin/app-settings/validation`, {
      'x-test-user-id': String(adminId),
    });
    expect(before.status).toBe(200);
    const beforeEntries = (asObject(before.body).entries as Array<Record<string, unknown>>);
    const broken = beforeEntries.find((e) => e.key === SQUARE_RATE_LIMIT_ALERT_SETTING_KEY)!;
    expect(broken.status).toBe('invalid');
    const issues = broken.issues as Array<{ path: string; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path === 'threshold')).toBe(true);

    // Simulate the fix-up migration described in the runbook —
    // delete the bad row so the consumer falls back to defaults.
    await db
      .delete(appSettings)
      .where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));

    const after = await getJson(`${baseUrl}/api/admin/app-settings/validation`, {
      'x-test-user-id': String(adminId),
    });
    expect(after.status).toBe(200);
    const afterEntries = (asObject(after.body).entries as Array<Record<string, unknown>>);
    const fixed = afterEntries.find((e) => e.key === SQUARE_RATE_LIMIT_ALERT_SETTING_KEY)!;
    expect(fixed.status).toBe('missing');
    expect(fixed.issues).toEqual([]);
  });
});
