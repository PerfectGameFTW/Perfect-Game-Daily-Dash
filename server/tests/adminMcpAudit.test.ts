/**
 * Pins the auth posture and query-validation contract on
 * `GET /api/admin/mcp-audit` (Task #109).
 *
 * The endpoint exposes a paginated browser over `mcp_query_audit` —
 * the audit trail of who ran which read-only SQL through the MCP
 * tool. A regression in middleware order or in the Zod schema would
 * silently expose that history (admin usernames, query text, IPs)
 * to non-admins, so the contract gets its own tests rather than
 * relying on the underlying middleware's tests.
 *
 * Mirrors the test shim in `squareRateLimitAlertSettings.test.ts`:
 * a tiny in-process express app with the real `createApiRouter()`
 * mounted, a header-driven session shim (`x-test-user-id`) so we
 * can flip identities without standing up express-session, and the
 * real Postgres-backed storage so the route's interaction with
 * `pgStorage.listMcpQueryAudit` is exercised end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import { users, mcpQueryAudit } from '@shared/schema';
import { authService } from '../services/authService';
import { createApiRouter } from '../routes/api';
import { pgStorage } from '../pgStorage';

const TEST_ADMIN_USERNAME = '__mcp_audit_admin__';
const TEST_USER_USERNAME = '__mcp_audit_user__';
const STRONG_PASSWORD = 'Str0ng!McpAudit-Test-9z';

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

describe('GET /api/admin/mcp-audit auth posture and validation (Task #109)', () => {
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let userId: number;
  // Audit-row IDs we seed so we can clean them back up without
  // touching whatever the test DB happens to already contain from
  // other suites.
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

    // Seed two audit rows (one success, one error) under the admin
    // identity so the success-path admin GET has concrete data to
    // page over and we can assert the response shape.
    const inserted = await db
      .insert(mcpQueryAudit)
      .values([
        {
          adminUserId: adminId,
          ip: '127.0.0.1',
          query: 'SELECT 1',
          rowCount: 1,
          error: null,
          durationMs: 5,
        },
        {
          adminUserId: adminId,
          ip: '127.0.0.1',
          query: 'SELECT * FROM nonexistent',
          rowCount: null,
          error: 'relation "nonexistent" does not exist',
          durationMs: 7,
        },
      ])
      .returning({ id: mcpQueryAudit.id });
    for (const row of inserted) seededAuditIds.push(row.id);

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());

    // Test-only session shim — picks identity from `x-test-user-id`
    // so we can flip between unauthenticated / non-admin / admin
    // per request without express-session or real cookies. Only the
    // bits requireAuth actually reads (`userId` + `destroy`) are
    // populated.
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
      await db.delete(mcpQueryAudit).where(inArray(mcpQueryAudit.id, seededAuditIds));
    }
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(() => {
    // The user-cache TTL means a row mutation between tests could
    // be invisible until the cached entry expires. We don't mutate
    // the seeded users mid-suite, but invalidate defensively so any
    // future test edit is honoured immediately.
    authService.invalidateUserCache?.(adminId);
    authService.invalidateUserCache?.(userId);
  });

  describe('auth posture', () => {
    it('rejects unauthenticated GET with 401 and exposes no audit data', async () => {
      const r = await getJson(`${baseUrl}/api/admin/mcp-audit`);
      expect(r.status).toBe(401);
      // Body MUST NOT carry audit rows under any error shape.
      const body = asObject(r.body);
      expect(body.entries).toBeUndefined();
      expect(body.total).toBeUndefined();
    });

    it('rejects logged-in non-admin GET with 403 and exposes no audit data', async () => {
      const r = await getJson(`${baseUrl}/api/admin/mcp-audit`, {
        'x-test-user-id': String(userId),
      });
      expect(r.status).toBe(403);
      const body = asObject(r.body);
      expect(body.entries).toBeUndefined();
      expect(body.total).toBeUndefined();
    });

    it('allows logged-in admin GET with 200 and returns the seeded audit rows', async () => {
      // Filter to the admin we seeded under so this assertion is
      // robust against unrelated rows that other suites may have
      // left in the table.
      const r = await getJson(
        `${baseUrl}/api/admin/mcp-audit?adminUsername=${encodeURIComponent(TEST_ADMIN_USERNAME)}`,
        { 'x-test-user-id': String(adminId) },
      );
      expect(r.status).toBe(200);
      const body = asObject(r.body);
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.total).toBe(2);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
      const entries = body.entries as Array<Record<string, unknown>>;
      // Both seeded rows should come back, identifiable by the
      // distinctive query strings — not by id, since we don't want
      // this test to assert ordering beyond what the route promises.
      const queries = entries.map((e) => e.query as string).sort();
      expect(queries).toContain('SELECT 1');
      expect(queries).toContain('SELECT * FROM nonexistent');
    });
  });

  describe('filter parameter validation', () => {
    /** Helper: every malformed-input case returns 400 with a JSON
     *  body that explicitly says the input was invalid AND points at
     *  the offending field path so a frontend can surface it. */
    async function expectBadRequest(qs: string, fieldPath: string): Promise<void> {
      const r = await getJson(`${baseUrl}/api/admin/mcp-audit?${qs}`, {
        'x-test-user-id': String(adminId),
      });
      expect(r.status).toBe(400);
      const body = asObject(r.body);
      expect(String(body.error)).toMatch(/invalid/i);
      expect(Array.isArray(body.issues)).toBe(true);
      const issues = body.issues as Array<{ path: string; message: string }>;
      expect(issues.some((i) => i.path === fieldPath)).toBe(true);
    }

    it('rejects an `outcome` outside the {success, error} enum with 400', async () => {
      await expectBadRequest('outcome=maybe', 'outcome');
    });

    it('rejects a `startDate` that is not an ISO 8601 datetime with 400', async () => {
      await expectBadRequest('startDate=not-a-date', 'startDate');
    });

    it('rejects an `endDate` that is not an ISO 8601 datetime with 400', async () => {
      await expectBadRequest('endDate=2024-13-99', 'endDate');
    });

    it('rejects a `limit` below the minimum of 1 with 400', async () => {
      await expectBadRequest('limit=0', 'limit');
    });

    it('rejects a `limit` above the maximum of 200 with 400', async () => {
      await expectBadRequest('limit=201', 'limit');
    });

    it('rejects a non-numeric `limit` with 400', async () => {
      await expectBadRequest('limit=abc', 'limit');
    });

    it('rejects a negative `offset` with 400', async () => {
      await expectBadRequest('offset=-1', 'offset');
    });

    it('rejects a non-numeric `offset` with 400', async () => {
      await expectBadRequest('offset=abc', 'offset');
    });

    it('rejects an `adminUsername` longer than 100 characters with 400', async () => {
      const long = 'a'.repeat(101);
      await expectBadRequest(`adminUsername=${long}`, 'adminUsername');
    });

    it('accepts a fully-populated set of valid filters with 200', async () => {
      // Pin the happy path so the validation schema can't drift
      // into being accidentally too strict and start rejecting
      // legitimate requests from the admin UI.
      const qs = new URLSearchParams({
        adminUsername: TEST_ADMIN_USERNAME,
        outcome: 'success',
        startDate: '2020-01-01T00:00:00.000Z',
        endDate: '2099-12-31T23:59:59.000Z',
        limit: '25',
        offset: '0',
      }).toString();
      const r = await getJson(`${baseUrl}/api/admin/mcp-audit?${qs}`, {
        'x-test-user-id': String(adminId),
      });
      expect(r.status).toBe(200);
      const body = asObject(r.body);
      expect(body.limit).toBe(25);
      expect(body.offset).toBe(0);
      // The seeded rows include exactly one success row under the
      // admin's username, so the success-only filter should narrow
      // the response to that single row.
      expect(body.total).toBe(1);
      const entries = body.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0].query).toBe('SELECT 1');
      expect(entries[0].error).toBeNull();
    });

    it('does not invoke the storage layer when query parameters are malformed', async () => {
      // Spy-style guarantee that the 400 is returned by the route
      // BEFORE the DB is touched. If listMcpQueryAudit ran with the
      // malformed value, the call count would tick.
      const before = (pgStorage.listMcpQueryAudit as unknown as { __callCount?: number })
        .__callCount;
      let calls = 0;
      const original = pgStorage.listMcpQueryAudit.bind(pgStorage);
      const wrapped = async (...args: Parameters<typeof original>) => {
        calls += 1;
        return original(...args);
      };
      (pgStorage as unknown as { listMcpQueryAudit: typeof wrapped }).listMcpQueryAudit =
        wrapped;
      try {
        const r = await getJson(`${baseUrl}/api/admin/mcp-audit?limit=999`, {
          'x-test-user-id': String(adminId),
        });
        expect(r.status).toBe(400);
        expect(calls).toBe(0);
      } finally {
        (pgStorage as unknown as { listMcpQueryAudit: typeof original }).listMcpQueryAudit =
          original;
        // Touch `before` so the unused-var lint doesn't complain.
        void before;
      }
    });
  });
});
