/**
 * Coverage for GET /api/auth/admin/security/audit (Task #126).
 *
 * The endpoint is the read-only counterpart to the
 * `recordSecurityAudit` / *WithAudit transactional helpers in
 * pgStorage. Tests assert:
 *   - The route is admin-gated (non-admin gets 403, anonymous gets 401).
 *   - It returns rows newest-first with usernames joined in.
 *   - Filters (action, actorUsername, targetUsername) narrow correctly.
 *   - Pagination (limit/offset) honors total + page size.
 *   - The distinct `actions` list is populated from the table.
 *   - There is no DELETE/PATCH route — the table is append-only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import { users, securityAuditLog } from '@shared/schema';
import { authService } from '../services/authService';
import { createAuthRouter } from '../routes/auth';

let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  return `192.0.2.${(__ipCounter % 254) + 1}`;
}

interface JsonResp { status: number; body: any; cookie: string | null; }

async function jsonReq(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  payload?: unknown,
  cookie?: string,
): Promise<JsonResp> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': uniqueIp(),
  };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, body, cookie: setCookie };
}

const ADMIN_AUDIT_ACTOR = '__sec_audit_actor__';
const ADMIN_AUDIT_TARGET = '__sec_audit_target__';
const NORMAL_USER = '__sec_audit_user__';
const PWD = 'Sec.Audit-Test-Pwd-99';

describe('GET /admin/security/audit (Task #126)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let actorId: number;
  let targetId: number;
  let normalUserId: number;

  beforeAll(async () => {
    await db.delete(users).where(inArray(users.username, [ADMIN_AUDIT_ACTOR, ADMIN_AUDIT_TARGET, NORMAL_USER]));
    const a = await authService.registerUser(ADMIN_AUDIT_ACTOR, PWD, 'admin');
    actorId = a.id;
    const b = await authService.registerUser(ADMIN_AUDIT_TARGET, PWD, 'admin');
    targetId = b.id;
    const u = await authService.registerUser(NORMAL_USER, PWD, 'user');
    normalUserId = u.id;

    app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use(
      session({
        name: 'pgs.sid',
        secret: 'test-secret-do-not-use-elsewhere',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax', secure: false },
      }),
    );
    app.use('/api/auth', createAuthRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db
      .delete(securityAuditLog)
      .where(inArray(securityAuditLog.actorUserId, [actorId, targetId]));
    await db.delete(users).where(inArray(users.id, [actorId, targetId, normalUserId]));
  });

  beforeEach(async () => {
    await db
      .delete(securityAuditLog)
      .where(inArray(securityAuditLog.actorUserId, [actorId, targetId]));
    // Seed a deterministic set of rows. Inserting one at a time so the
    // `created_at` ordering is stable (the SELECT orders by
    // created_at DESC, id DESC).
    await db.insert(securityAuditLog).values({
      actorUserId: actorId,
      actorIp: '10.0.0.1',
      action: 'require_admin_2fa.set',
      targetUserId: null,
      metadata: { previous: false, next: true },
    });
    await db.insert(securityAuditLog).values({
      actorUserId: actorId,
      actorIp: '10.0.0.2',
      action: 'user.totp_disabled_by_admin',
      targetUserId: targetId,
      metadata: { targetUsername: ADMIN_AUDIT_TARGET, wasEnabled: true },
    });
    await db.insert(securityAuditLog).values({
      actorUserId: targetId,
      actorIp: '10.0.0.3',
      action: 'require_admin_2fa.set',
      targetUserId: null,
      metadata: { previous: true, next: false },
    });
  });

  async function login(username: string): Promise<string> {
    const r = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', { username, password: PWD });
    expect(r.status).toBe(200);
    expect(r.cookie).toBeTruthy();
    return r.cookie!.split(';')[0];
  }

  it('rejects anonymous requests with 401', async () => {
    const r = await jsonReq(`${baseUrl}/api/auth/admin/security/audit`, 'GET');
    expect(r.status).toBe(401);
  });

  it('rejects non-admins with 403', async () => {
    const cookie = await login(NORMAL_USER);
    const r = await jsonReq(`${baseUrl}/api/auth/admin/security/audit`, 'GET', undefined, cookie);
    expect(r.status).toBe(403);
  });

  it('returns rows newest-first with joined usernames and action list', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?actorUsername=__sec_audit_`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.entries).toHaveLength(3);
    // Newest-first: the third insert is the latest.
    expect(r.body.entries[0]).toMatchObject({
      action: 'require_admin_2fa.set',
      actorUserId: targetId,
      actorUsername: ADMIN_AUDIT_TARGET,
      targetUserId: null,
      targetUsername: null,
    });
    expect(r.body.entries[1]).toMatchObject({
      action: 'user.totp_disabled_by_admin',
      actorUserId: actorId,
      actorUsername: ADMIN_AUDIT_ACTOR,
      targetUserId: targetId,
      targetUsername: ADMIN_AUDIT_TARGET,
    });
    expect(r.body.entries[2]).toMatchObject({
      action: 'require_admin_2fa.set',
      actorUserId: actorId,
      actorUsername: ADMIN_AUDIT_ACTOR,
    });
    // Distinct action codes, ascending.
    expect(r.body.actions).toEqual(
      expect.arrayContaining(['require_admin_2fa.set', 'user.totp_disabled_by_admin']),
    );
  });

  it('filters by action exactly', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?action=user.totp_disabled_by_admin&actorUsername=__sec_audit_`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.entries[0].action).toBe('user.totp_disabled_by_admin');
  });

  it('filters by actor username substring (case-insensitive)', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?actorUsername=AUDIT_ACTOR`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    for (const entry of r.body.entries) {
      expect(entry.actorUsername).toBe(ADMIN_AUDIT_ACTOR);
    }
  });

  it('filters by target username', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?targetUsername=__sec_audit_target__`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.entries[0]).toMatchObject({
      action: 'user.totp_disabled_by_admin',
      targetUsername: ADMIN_AUDIT_TARGET,
    });
  });

  it('honours limit + offset for pagination', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const r1 = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?actorUsername=__sec_audit_&limit=2&offset=0`,
      'GET',
      undefined,
      cookie,
    );
    expect(r1.status).toBe(200);
    expect(r1.body.total).toBe(3);
    expect(r1.body.entries).toHaveLength(2);

    const r2 = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?actorUsername=__sec_audit_&limit=2&offset=2`,
      'GET',
      undefined,
      cookie,
    );
    expect(r2.status).toBe(200);
    expect(r2.body.entries).toHaveLength(1);
    // Page 2 should not duplicate page 1 IDs.
    const ids1 = r1.body.entries.map((e: any) => e.id);
    const ids2 = r2.body.entries.map((e: any) => e.id);
    for (const id of ids2) expect(ids1).not.toContain(id);
  });

  it('rejects invalid limit/offset with a 400', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/audit?limit=0`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(400);
  });

  it('exposes no DELETE or PATCH on the audit endpoint', async () => {
    const cookie = await login(ADMIN_AUDIT_ACTOR);
    const del = await jsonReq(`${baseUrl}/api/auth/admin/security/audit`, 'DELETE', undefined, cookie);
    // 404 from express (no route) or 405; either way, NOT a 2xx.
    expect(del.status).toBeGreaterThanOrEqual(400);
    const patch = await jsonReq(`${baseUrl}/api/auth/admin/security/audit/1`, 'PATCH', { foo: 'bar' }, cookie);
    expect(patch.status).toBeGreaterThanOrEqual(400);
    // Sanity: rows are still there.
    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, actorId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
