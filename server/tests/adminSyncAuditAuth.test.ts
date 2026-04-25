/**
 * Pins the auth posture on `GET /api/admin/sync-audit` (Task #118).
 *
 * The endpoint exposes the audit history of who triggered each
 * historical/backfill sync run, with which params, and how it ended.
 * It's gated by the router-level `requireAuth` (mounted in
 * `createApiRouter`) plus an explicit `requireAdmin` on the route. A
 * future middleware refactor could quietly drop one of those two
 * guards and silently leak the trail to non-admins, so the contract
 * gets its own regression test rather than relying on the
 * middleware's own tests.
 *
 * Modelled on `adminMcpAudit.test.ts`: a tiny in-process express app
 * with the real `createApiRouter()` mounted, a header-driven session
 * shim (`x-test-user-id`) so we can flip identities without standing
 * up express-session, and the real Postgres-backed storage so the
 * route's interaction with `pgStorage.listSyncAudit` is exercised
 * end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import { users, syncAudit } from '@shared/schema';
import { authService } from '../services/authService';
import { createApiRouter } from '../routes/api';

const TEST_ADMIN_USERNAME = '__sync_audit_auth_admin__';
const TEST_USER_USERNAME = '__sync_audit_auth_user__';
const STRONG_PASSWORD = 'Str0ng!SyncAuditAuth-Test-9z';

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

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResp> {
  const r = await fetch(url, { headers });
  return { status: r.status, body: parseJsonBody(await r.text()) };
}

function asObject(body: JsonBody): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Expected JSON object response, got: ${String(body)}`);
  }
  return body;
}

describe('GET /api/admin/sync-audit auth posture (Task #118)', () => {
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let userId: number;
  // Audit-row IDs we seed so we can clean them up without disturbing
  // whatever the test DB happens to already contain from other suites.
  const seededAuditIds: number[] = [];

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, TEST_ADMIN_USERNAME));
    await db.delete(users).where(eq(users.username, TEST_USER_USERNAME));

    const admin = await authService.registerUser(
      TEST_ADMIN_USERNAME,
      STRONG_PASSWORD,
      'admin',
    );
    adminId = admin.id;
    const user = await authService.registerUser(
      TEST_USER_USERNAME,
      STRONG_PASSWORD,
      'user',
    );
    userId = user.id;

    // Seed one sync_audit row under the test admin so the success
    // assertion below has a concrete row to find without depending on
    // unrelated data left by other suites. The shape mirrors what
    // `recordAuditStart` would write for a real run.
    const inserted = await db
      .insert(syncAudit)
      .values({
        syncType: '__sync_audit_auth_test__',
        action: 'start',
        actorUserId: adminId,
        actorIp: '127.0.0.1',
        params: { note: 'Task #118 auth-posture seed' },
        status: 'completed',
        result: { processed: 0 },
      })
      .returning({ id: syncAudit.id });
    for (const row of inserted) seededAuditIds.push(row.id);

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());

    // Test-only session shim — picks identity from `x-test-user-id`
    // so we can flip between unauthenticated / non-admin / admin per
    // request without express-session or real cookies. Only the bits
    // requireAuth actually reads (`userId` + `destroy`) are populated.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const asUserId = req.headers['x-test-user-id'];
      const session: TestSession = {
        destroy: (cb) => {
          if (cb) cb();
        },
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
    if (seededAuditIds.length > 0) {
      await db.delete(syncAudit).where(inArray(syncAudit.id, seededAuditIds));
    }
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(() => {
    // The user-cache TTL means a row mutation between tests could be
    // invisible until the cached entry expires. We don't mutate the
    // seeded users mid-suite, but invalidate defensively so any
    // future test edit is honoured immediately.
    authService.invalidateUserCache?.(adminId);
    authService.invalidateUserCache?.(userId);
  });

  it('rejects unauthenticated GET with 401 and exposes no audit data', async () => {
    const r = await getJson(`${baseUrl}/api/admin/sync-audit`);
    expect(r.status).toBe(401);
    // Body MUST NOT carry audit rows under any error shape.
    const body = asObject(r.body);
    expect(body.entries).toBeUndefined();
    expect(body.total).toBeUndefined();
    expect(body.syncTypes).toBeUndefined();
  });

  it('rejects logged-in non-admin GET with 403 and exposes no audit data', async () => {
    const r = await getJson(`${baseUrl}/api/admin/sync-audit`, {
      'x-test-user-id': String(userId),
    });
    expect(r.status).toBe(403);
    const body = asObject(r.body);
    expect(body.entries).toBeUndefined();
    expect(body.total).toBeUndefined();
    expect(body.syncTypes).toBeUndefined();
  });

  it('allows logged-in admin GET with 200 and returns the seeded audit row', async () => {
    // Filter to the synthetic syncType we seeded under so this
    // assertion is robust against unrelated rows other suites may
    // have left in the table.
    const qs = new URLSearchParams({
      syncType: '__sync_audit_auth_test__',
    }).toString();
    const r = await getJson(`${baseUrl}/api/admin/sync-audit?${qs}`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(200);
    const body = asObject(r.body);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.total).toBe(1);
    const entries = body.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].syncType).toBe('__sync_audit_auth_test__');
    expect(entries[0].actorUserId).toBe(adminId);
    expect(entries[0].actorUsername).toBe(TEST_ADMIN_USERNAME);
  });

  it('does not leak audit data when the session id points at a non-existent user', async () => {
    // Belt-and-suspenders for the requireAuth path: a stale cookie
    // whose user id has since been deleted must be rejected with 401,
    // not silently treated as anonymous-and-let-through.
    const r = await getJson(`${baseUrl}/api/admin/sync-audit`, {
      'x-test-user-id': '999999999',
    });
    expect(r.status).toBe(401);
    const body = asObject(r.body);
    expect(body.entries).toBeUndefined();
    expect(body.total).toBeUndefined();
  });
});
