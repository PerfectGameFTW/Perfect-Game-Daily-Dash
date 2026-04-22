import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray, desc } from 'drizzle-orm';

import { db } from '../db';
import { users, securityAuditLog, appSettings, REQUIRE_ADMIN_2FA_SETTING_KEY } from '@shared/schema';
import { authService } from '../services/authService';
import { totpService } from '../services/totpService';
import { createAuthRouter } from '../routes/auth';

let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  return `192.0.2.${(__ipCounter % 254) + 1}`;
}

interface JsonResp {
  status: number;
  body: any;
  cookie: string | null;
}

async function jsonReq(
  url: string,
  method: 'GET' | 'POST' | 'PUT',
  payload: unknown,
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

const ADMIN_A = '__admin_2fa_a__';
const ADMIN_B = '__admin_2fa_b__';
const NORMAL_USER = '__user_2fa_x__';
const PWD = 'Adm1n!2faTest-Pwd-99';

describe('Admin Security overview + require-2FA toggle (Task #100)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let adminAId: number;
  let adminBId: number;
  let normalUserId: number;

  beforeAll(async () => {
    await db.delete(users).where(inArray(users.username, [ADMIN_A, ADMIN_B, NORMAL_USER]));

    const a = await authService.registerUser(ADMIN_A, PWD, 'admin');
    adminAId = a.id;
    const b = await authService.registerUser(ADMIN_B, PWD, 'admin');
    adminBId = b.id;
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
      .where(inArray(securityAuditLog.actorUserId, [adminAId, adminBId]));
    await db
      .delete(appSettings)
      .where(eq(appSettings.key, REQUIRE_ADMIN_2FA_SETTING_KEY));
    await db.delete(users).where(inArray(users.id, [adminAId, adminBId, normalUserId]));
  });

  beforeEach(async () => {
    // Reset 2FA state on every test row + clear the toggle so each test
    // starts from a clean slate.
    await db
      .update(users)
      .set({ totpEnabled: false, totpSecretEncrypted: null, totpRecoveryCodes: null, totpLastUsedAt: null })
      .where(inArray(users.id, [adminAId, adminBId, normalUserId]));
    await db
      .delete(appSettings)
      .where(eq(appSettings.key, REQUIRE_ADMIN_2FA_SETTING_KEY));
    authService.invalidateUserCache(adminAId);
    authService.invalidateUserCache(adminBId);
    authService.invalidateUserCache(normalUserId);
  });

  async function loginNoTotp(username: string): Promise<string> {
    const r = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username,
      password: PWD,
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.cookie).toBeTruthy();
    // Cookie value (everything before the first ;) is what subsequent
    // requests need to send back.
    return r.cookie!.split(';')[0];
  }

  it('GET /admin/security/overview returns safe rows for every user', async () => {
    const cookie = await loginNoTotp(ADMIN_A);
    const r = await jsonReq(`${baseUrl}/api/auth/admin/security/overview`, 'GET', undefined, cookie);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const ids = r.body.map((row: any) => row.id);
    expect(ids).toEqual(expect.arrayContaining([adminAId, adminBId, normalUserId]));
    const a = r.body.find((row: any) => row.id === adminAId);
    expect(a).toMatchObject({
      username: ADMIN_A,
      role: 'admin',
      totpEnabled: false,
      recoveryCodesRemaining: 0,
      totpLastUsedAt: null,
    });
    // Should never leak the password hash or encrypted secret.
    expect(a.password).toBeUndefined();
    expect(a.totpSecretEncrypted).toBeUndefined();
    expect(a.totpRecoveryCodes).toBeUndefined();
  });

  it('non-admins cannot read the overview', async () => {
    const cookie = await loginNoTotp(NORMAL_USER);
    const r = await jsonReq(`${baseUrl}/api/auth/admin/security/overview`, 'GET', undefined, cookie);
    expect(r.status).toBe(403);
  });

  it('PUT /admin/security/require-2fa persists the toggle and writes an audit row', async () => {
    const cookie = await loginNoTotp(ADMIN_A);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/require-2fa`,
      'PUT',
      { enabled: true },
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const stored = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, REQUIRE_ADMIN_2FA_SETTING_KEY));
    expect(stored[0]?.value).toEqual({ enabled: true });

    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminAId))
      .orderBy(desc(securityAuditLog.id))
      .limit(1);
    expect(audit[0]).toMatchObject({
      action: 'require_admin_2fa.set',
      actorUserId: adminAId,
      targetUserId: null,
    });
    expect(audit[0]?.metadata).toMatchObject({ next: true });
  });

  it('/me reports mustEnrollTotp=true for an admin without TOTP when the toggle is on', async () => {
    // Turn the toggle on as admin A (who promptly enrolls so we can use
    // admin B as the bare-admin subject).
    const cookieA = await loginNoTotp(ADMIN_A);
    await jsonReq(
      `${baseUrl}/api/auth/admin/security/require-2fa`,
      'PUT',
      { enabled: true },
      cookieA,
    );

    // Admin B logs in (no TOTP); /me should report the gate.
    const cookieB = await loginNoTotp(ADMIN_B);
    const me = await jsonReq(`${baseUrl}/api/auth/me`, 'GET', undefined, cookieB);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('admin');
    expect(me.body.totpEnabled).toBe(false);
    expect(me.body.mustEnrollTotp).toBe(true);

    // Normal user is unaffected.
    const cookieU = await loginNoTotp(NORMAL_USER);
    const meU = await jsonReq(`${baseUrl}/api/auth/me`, 'GET', undefined, cookieU);
    expect(meU.body.mustEnrollTotp).toBe(false);
  });

  it('/me reports mustEnrollTotp=false once an admin enrolls TOTP', async () => {
    const cookieA = await loginNoTotp(ADMIN_A);
    await jsonReq(
      `${baseUrl}/api/auth/admin/security/require-2fa`,
      'PUT',
      { enabled: true },
      cookieA,
    );
    // Simulate enrollment directly on admin A.
    await totpService.beginEnrollment(await authService.getUserById(adminAId)!);
    // Force-flip totpEnabled (we don't have a valid TOTP code in the
    // test).
    await db
      .update(users)
      .set({ totpEnabled: true, totpRecoveryCodes: ['x'] })
      .where(eq(users.id, adminAId));
    authService.invalidateUserCache(adminAId);

    const me = await jsonReq(`${baseUrl}/api/auth/me`, 'GET', undefined, cookieA);
    expect(me.body.totpEnabled).toBe(true);
    expect(me.body.mustEnrollTotp).toBe(false);
  });

  it('admin can disable another admin\'s 2FA with a password re-check; audit row is written', async () => {
    // Pre-enable 2FA on admin B directly.
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: 'placeholder', totpRecoveryCodes: ['a', 'b'] })
      .where(eq(users.id, adminBId));
    authService.invalidateUserCache(adminBId);

    const cookie = await loginNoTotp(ADMIN_A);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/users/${adminBId}/disable-totp`,
      'POST',
      { password: PWD },
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    const after = await db.select().from(users).where(eq(users.id, adminBId));
    expect(after[0]?.totpEnabled).toBe(false);
    expect(after[0]?.totpSecretEncrypted).toBeNull();
    expect(after[0]?.totpRecoveryCodes).toBeNull();

    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.targetUserId, adminBId))
      .orderBy(desc(securityAuditLog.id))
      .limit(1);
    expect(audit[0]).toMatchObject({
      action: 'user.totp_disabled_by_admin',
      actorUserId: adminAId,
      targetUserId: adminBId,
    });
    expect(audit[0]?.metadata).toMatchObject({ targetUsername: ADMIN_B, wasEnabled: true });
  });

  it('rejects disable-totp with the wrong password', async () => {
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: 'placeholder', totpRecoveryCodes: ['a'] })
      .where(eq(users.id, adminBId));
    authService.invalidateUserCache(adminBId);

    const cookie = await loginNoTotp(ADMIN_A);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/users/${adminBId}/disable-totp`,
      'POST',
      { password: 'wrong-password-for-test' },
      cookie,
    );
    expect(r.status).toBe(401);

    const after = await db.select().from(users).where(eq(users.id, adminBId));
    expect(after[0]?.totpEnabled).toBe(true);
  });

  it('admin cannot disable their own 2FA via the admin endpoint (must use self-service)', async () => {
    // Log in first (no TOTP yet), then flip the row to simulate an
    // already-enrolled admin trying to use the wrong endpoint on
    // themselves. Doing it the other way around would block login on the
    // missing TOTP step.
    const cookie = await loginNoTotp(ADMIN_A);
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: 'placeholder', totpRecoveryCodes: ['a'] })
      .where(eq(users.id, adminAId));
    authService.invalidateUserCache(adminAId);

    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/users/${adminAId}/disable-totp`,
      'POST',
      { password: PWD },
      cookie,
    );
    expect(r.status).toBe(400);

    const after = await db.select().from(users).where(eq(users.id, adminAId));
    expect(after[0]?.totpEnabled).toBe(true);
  });

  it('refuses to disable 2FA on non-admin accounts via the admin endpoint', async () => {
    // Pre-enable on the regular user just so the only thing that should
    // make this fail is the role check.
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: 'placeholder', totpRecoveryCodes: ['a'] })
      .where(eq(users.id, normalUserId));
    authService.invalidateUserCache(normalUserId);

    const cookie = await loginNoTotp(ADMIN_A);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/users/${normalUserId}/disable-totp`,
      'POST',
      { password: PWD },
      cookie,
    );
    expect(r.status).toBe(400);

    const after = await db.select().from(users).where(eq(users.id, normalUserId));
    expect(after[0]?.totpEnabled).toBe(true);
  });

  it('blocks non-enrolled admin from protected APIs once require-2FA is on but allows enrollment + identity routes', async () => {
    // Admin A turns the toggle on, then admin B (no TOTP) logs in.
    const cookieA = await loginNoTotp(ADMIN_A);
    await jsonReq(
      `${baseUrl}/api/auth/admin/security/require-2fa`,
      'PUT',
      { enabled: true },
      cookieA,
    );

    const cookieB = await loginNoTotp(ADMIN_B);

    // Admin endpoints must be denied with TOTP_ENROLLMENT_REQUIRED, not
    // silently allowed — this is the actual enforcement boundary the
    // mustEnrollTotp gate stands in for.
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/admin/security/overview`,
      'GET',
      undefined,
      cookieB,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TOTP_ENROLLMENT_REQUIRED');

    // /me must still work (so the SPA can render the enrollment screen
    // with the user's username/role) and so should the TOTP enrollment
    // endpoints (otherwise the admin can never get unstuck).
    const me = await jsonReq(`${baseUrl}/api/auth/me`, 'GET', undefined, cookieB);
    expect(me.status).toBe(200);
    expect(me.body.mustEnrollTotp).toBe(true);

    const enroll = await jsonReq(
      `${baseUrl}/api/auth/totp/enrollment/begin`,
      'POST',
      undefined,
      cookieB,
    );
    // We don't care about the body shape here, just that the gate let
    // the request through to the route handler (i.e. it's not 403 with
    // TOTP_ENROLLMENT_REQUIRED).
    expect(enroll.body?.code).not.toBe('TOTP_ENROLLMENT_REQUIRED');

    // Logout must remain available so a stuck admin can sign out.
    const logout = await jsonReq(`${baseUrl}/api/auth/logout`, 'POST', undefined, cookieB);
    expect(logout.body?.code).not.toBe('TOTP_ENROLLMENT_REQUIRED');
  });

  it('does not block normal users when require-2FA is on (gate is admin-only)', async () => {
    const cookieA = await loginNoTotp(ADMIN_A);
    await jsonReq(
      `${baseUrl}/api/auth/admin/security/require-2fa`,
      'PUT',
      { enabled: true },
      cookieA,
    );
    const cookieU = await loginNoTotp(NORMAL_USER);
    const me = await jsonReq(`${baseUrl}/api/auth/me`, 'GET', undefined, cookieU);
    expect(me.status).toBe(200);
    expect(me.body.mustEnrollTotp).toBe(false);
  });

  it('non-admins cannot call the disable endpoint', async () => {
    const cookie = await loginNoTotp(NORMAL_USER);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/users/${adminBId}/disable-totp`,
      'POST',
      { password: PWD },
      cookie,
    );
    expect(r.status).toBe(403);
  });
});
