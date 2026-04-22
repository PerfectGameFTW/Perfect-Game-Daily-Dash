/**
 * Integration test for the admin-tunable Square 429 alert thresholds
 * (Task #96). Covers PUT -> app_settings -> in-process alerter,
 * boot-time hydration after a simulated cold start, and the
 * admin-only auth posture on the GET/PUT endpoints.
 *
 * Vitest's default forks pool isolates each test file in its own
 * worker, so the process-global `squareRateLimitAlerter` mutated
 * here does not bleed into squareRateLimitAlert.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

import { db } from '../db';
import {
  users,
  appSettings,
  SQUARE_RATE_LIMIT_ALERT_SETTING_KEY,
} from '@shared/schema';
import { authService } from '../services/authService';
import { createApiRouter } from '../routes/api';
import { squareRateLimitAlerter } from '../services/squareRateLimitAlert';
import { loadSquareRateLimitAlertOverride } from '../services/squareRateLimitAlertSettings';

const TEST_ADMIN_USERNAME = '__rl_alert_admin__';
const TEST_USER_USERNAME = '__rl_alert_user__';
const STRONG_PASSWORD = 'Str0ng!RL-Alert-Test-9z';

// Minimal session shape requireAuth touches: a user id and a destroy
// callback. Declared so the shim middleware below stays fully typed.
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
  return { status: r.status, body: parseJsonBody(await r.text()) };
}

async function putJson(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<JsonResp> {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: parseJsonBody(await r.text()) };
}

function asObject(body: JsonBody): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Expected JSON object response, got: ${String(body)}`);
  }
  return body;
}

describe('Square 429 alert settings — admin tunable end-to-end (Task #96)', () => {
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let userId: number;

  beforeAll(async () => {
    // Wipe any leftover rows from a previous failed run.
    await db.delete(users).where(eq(users.username, TEST_ADMIN_USERNAME));
    await db.delete(users).where(eq(users.username, TEST_USER_USERNAME));

    const admin = await authService.registerUser(TEST_ADMIN_USERNAME, STRONG_PASSWORD, 'admin');
    adminId = admin.id;
    const user = await authService.registerUser(TEST_USER_USERNAME, STRONG_PASSWORD, 'user');
    userId = user.id;

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());

    // Test-only session shim: pick the identity per request via the
    // x-test-user-id header, no cookie/express-session needed. Only
    // the bits requireAuth actually reads (userId + destroy) are
    // populated.
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
    await db.delete(appSettings).where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, userId));
    squareRateLimitAlerter.reset();
  });

  beforeEach(async () => {
    await db.delete(appSettings).where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));
    squareRateLimitAlerter.reset();
    authService.invalidateUserCache?.(adminId);
    authService.invalidateUserCache?.(userId);
  });

  describe('auth posture', () => {
    it('rejects unauthenticated GET with 401', async () => {
      const r = await getJson(`${baseUrl}/api/admin/alerts/square-rate-limit`);
      expect(r.status).toBe(401);
    });

    it('rejects non-admin GET with 403', async () => {
      const r = await getJson(`${baseUrl}/api/admin/alerts/square-rate-limit`, {
        'x-test-user-id': String(userId),
      });
      expect(r.status).toBe(403);
    });

    it('rejects unauthenticated PUT with 401 and does not persist anything', async () => {
      const r = await putJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        { threshold: 7, windowMs: 120_000, cooldownMs: 120_000 },
      );
      expect(r.status).toBe(401);
      const persisted = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));
      expect(persisted).toHaveLength(0);
    });

    it('rejects non-admin PUT with 403 and does not persist anything', async () => {
      const r = await putJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        { threshold: 7, windowMs: 120_000, cooldownMs: 120_000 },
        { 'x-test-user-id': String(userId) },
      );
      expect(r.status).toBe(403);
      const persisted = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));
      expect(persisted).toHaveLength(0);
    });
  });

  describe('PUT applies live without restart', () => {
    it('PUT updates the in-process alerter immediately and persists to app_settings', async () => {
      const next = { threshold: 17, windowMs: 7 * 60_000, cooldownMs: 11 * 60_000 };

      const beforeTunable = squareRateLimitAlerter.getTunable();
      expect(beforeTunable).not.toEqual(next);

      const r = await putJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        next,
        { 'x-test-user-id': String(adminId) },
      );

      expect(r.status).toBe(200);
      const body = asObject(r.body);
      expect(body).toMatchObject(next);
      expect(typeof body.webhookConfigured).toBe('boolean');

      expect(squareRateLimitAlerter.getTunable()).toEqual(next);

      const persisted = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));
      expect(persisted).toHaveLength(1);
      expect(persisted[0].value).toEqual(next);
    });

    it('GET reflects the current effective tunable config after a PUT', async () => {
      const next = { threshold: 4, windowMs: 8 * 60_000, cooldownMs: 9 * 60_000 };
      const put = await putJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        next,
        { 'x-test-user-id': String(adminId) },
      );
      expect(put.status).toBe(200);

      const get = await getJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        { 'x-test-user-id': String(adminId) },
      );
      expect(get.status).toBe(200);
      expect(get.body).toMatchObject(next);
    });

    it('rejects malformed PUT payloads with 400 and leaves the alerter unchanged', async () => {
      const before = squareRateLimitAlerter.getTunable();
      const bad = await putJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        { threshold: 0, windowMs: 1_000, cooldownMs: 1_000 }, // all below schema mins
        { 'x-test-user-id': String(adminId) },
      );
      expect(bad.status).toBe(400);
      expect(asObject(bad.body).error).toMatch(/invalid/i);
      expect(squareRateLimitAlerter.getTunable()).toEqual(before);

      const persisted = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, SQUARE_RATE_LIMIT_ALERT_SETTING_KEY));
      expect(persisted).toHaveLength(0);
    });
  });

  describe('boot-time hydration re-applies the persisted override', () => {
    it('loadSquareRateLimitAlertOverride() restores the alerter to the persisted values after a simulated cold start', async () => {
      const next = { threshold: 23, windowMs: 6 * 60_000, cooldownMs: 13 * 60_000 };
      const put = await putJson(
        `${baseUrl}/api/admin/alerts/square-rate-limit`,
        next,
        { 'x-test-user-id': String(adminId) },
      );
      expect(put.status).toBe(200);

      squareRateLimitAlerter.reset();
      const envDefaults = squareRateLimitAlerter.getTunable();
      expect(envDefaults).not.toEqual(next);

      await loadSquareRateLimitAlertOverride();

      expect(squareRateLimitAlerter.getTunable()).toEqual(next);
    });

    it('loadSquareRateLimitAlertOverride() is a no-op when no row is persisted', async () => {
      squareRateLimitAlerter.reset();
      const before = squareRateLimitAlerter.getTunable();
      await loadSquareRateLimitAlertOverride();
      expect(squareRateLimitAlerter.getTunable()).toEqual(before);
    });
  });
});
