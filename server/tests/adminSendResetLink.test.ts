/**
 * Admin-initiated password reset endpoint (Task #116).
 *
 * Pins the contract that:
 *   - POST /api/auth/users/:id/send-reset-link is admin-only.
 *   - It actually creates a fresh password_reset_tokens row and calls
 *     the email transport (a future refactor that "succeeds" without
 *     issuing a token would silently break the operator's mental model
 *     and is caught here).
 *   - It writes one security_audit_log row per call with the actor +
 *     target ids and a non-PII metadata payload (target username +
 *     email domain only — never the full address).
 *   - It surfaces real failures (400 when the target has no email,
 *     404 when the target id is unknown, 500-class when SendGrid
 *     throws) instead of the generic 200 the public path returns for
 *     anti-enumeration. The whole point of this endpoint existing is
 *     that operators can SEE these failures.
 *   - It is NOT mounted behind `passwordResetRequestLimiter`: an
 *     authenticated admin can issue more than 3 reset emails per hour
 *     from a single IP (the public-path cap that this endpoint exists
 *     to bypass).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray, desc } from 'drizzle-orm';

import { db } from '../db';
import { users, passwordResetTokens, securityAuditLog } from '@shared/schema';
import { authService, invalidateUserCache } from '../services/authService';
import { encryptTotpSecret } from '../services/totpCrypto';
import * as emailService from '../services/emailService';
import { createAuthRouter } from '../routes/auth';
import { Secret, TOTP } from 'otpauth';

let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  // 198.51.100.0/24 (TEST-NET-2) keeps this suite's per-IP buckets
  // disjoint from the other auth tests.
  return `198.51.100.${(__ipCounter % 254) + 1}`;
}

interface JsonResp {
  status: number;
  body: any;
  cookie: string | null;
}

async function jsonReq(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  payload: unknown,
  cookie?: string,
  ip?: string,
): Promise<JsonResp> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ip ?? uniqueIp(),
  };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, body, cookie: setCookie };
}

const ADMIN = '__admin_send_reset__';
const NORMAL_USER = '__user_send_reset__';
const TARGET_WITH_EMAIL = '__target_with_email__';
const TARGET_NO_EMAIL = '__target_no_email__';
const TARGET_EMAIL = 'recipient@example.test';
const STRONG_PASSWORD = 'Adm1n!Send-Reset-Pwd-9z';

describe('Admin send-reset-link endpoint (Task #116)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let adminTotpSecret: Secret;
  let normalUserId: number;
  let targetWithEmailId: number;
  let targetNoEmailId: number;
  let prevAppBaseUrl: string | undefined;

  beforeAll(async () => {
    // Pin APP_BASE_URL so the in-test NODE_ENV (which may or may not
    // be 'production' depending on how the suite was launched) doesn't
    // change behavior. The admin route falls through to the request
    // host only when APP_BASE_URL is unset AND NODE_ENV !== 'production'.
    prevAppBaseUrl = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'http://test.invalid';

    await db.delete(users).where(
      inArray(users.username, [ADMIN, NORMAL_USER, TARGET_WITH_EMAIL, TARGET_NO_EMAIL]),
    );

    const a = await authService.registerUser(ADMIN, STRONG_PASSWORD, 'admin');
    adminId = a.id;
    // The mandatory-admin-2FA gate in `requireAuth` (Task #100) consults
    // a deployment-wide app_settings row. `adminTwoFactor.test.ts` toggles
    // that setting on/off in the shared test DB, and a parallel fork can
    // observe it as ON while this suite is mid-flight. Properly enrolling
    // this admin in TOTP sidesteps the gate (it only fires when
    // `role === 'admin' && !totpEnabled`), keeping this suite independent
    // of cross-file ordering. `loginAs` below completes the two-step login.
    adminTotpSecret = new Secret({ size: 20 });
    await db
      .update(users)
      .set({
        totpEnabled: true,
        totpSecretEncrypted: encryptTotpSecret(adminTotpSecret.base32),
        totpRecoveryCodes: ['unused-recovery-code'],
      })
      .where(eq(users.id, adminId));
    invalidateUserCache(adminId);
    const u = await authService.registerUser(NORMAL_USER, STRONG_PASSWORD, 'user');
    normalUserId = u.id;
    const t1 = await authService.registerUser(
      TARGET_WITH_EMAIL,
      STRONG_PASSWORD,
      'user',
      TARGET_EMAIL,
    );
    targetWithEmailId = t1.id;
    const t2 = await authService.registerUser(TARGET_NO_EMAIL, STRONG_PASSWORD, 'user');
    targetNoEmailId = t2.id;

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
      .where(inArray(securityAuditLog.actorUserId, [adminId]));
    // password_reset_tokens cascades on user delete.
    await db.delete(users).where(
      inArray(users.id, [adminId, normalUserId, targetWithEmailId, targetNoEmailId]),
    );
    if (prevAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = prevAppBaseUrl;
    }
  });

  beforeEach(async () => {
    await db
      .delete(passwordResetTokens)
      .where(inArray(passwordResetTokens.userId, [
        targetWithEmailId,
        targetNoEmailId,
      ]));
    await db
      .delete(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminId));
    vi.restoreAllMocks();
  });

  async function loginAs(username: string): Promise<string> {
    const r = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username,
      password: STRONG_PASSWORD,
    });
    expect(r.status).toBe(200);
    expect(r.cookie).toBeTruthy();
    let cookie = r.cookie!.split(';')[0];
    // The admin account is TOTP-enrolled (see beforeAll). Login returns
    // `{ requiresTotp: true }` and a pending-TOTP cookie; we still need
    // to exchange it for a fully authenticated session.
    if (r.body?.requiresTotp) {
      const code = new TOTP({
        issuer: 'Perfect Game Sales Dashboard',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: adminTotpSecret,
      }).generate();
      const v = await jsonReq(
        `${baseUrl}/api/auth/totp/verify`,
        'POST',
        { code },
        cookie,
      );
      expect(v.status).toBe(200);
      // The verify endpoint regenerates the session; pick up the new sid.
      if (v.cookie) cookie = v.cookie.split(';')[0];
    }
    return cookie;
  }

  it('rejects unauthenticated callers with 401', async () => {
    const r = await jsonReq(
      `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
      'POST',
      undefined,
    );
    expect(r.status).toBe(401);
  });

  it('rejects non-admin callers with 403', async () => {
    const cookie = await loginAs(NORMAL_USER);
    const sendSpy = vi.spyOn(emailService, 'sendEmail');
    const r = await jsonReq(
      `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );
    expect(r.status).toBe(403);
    // Must short-circuit before the service layer touches the email
    // transport — otherwise a non-admin could spam the inbox of any
    // user whose id they can guess.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('200 + issues a token + writes one audit row + sends one email when the target has an email', async () => {
    const cookie = await loginAs(ADMIN);
    const sendSpy = vi
      .spyOn(emailService, 'sendEmail')
      .mockResolvedValue(undefined as unknown as void);

    const r = await jsonReq(
      `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true });

    // Email was actually attempted with the target's address — a
    // future refactor that "succeeds" without calling the transport
    // would silently leave operators thinking the user got a link.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ to: TARGET_EMAIL });

    // Exactly one fresh, unused token row exists for the target.
    const tokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, targetWithEmailId));
    expect(tokens.length).toBe(1);
    expect(tokens[0].usedAt).toBeNull();

    // Exactly one audit row with the expected shape.
    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminId))
      .orderBy(desc(securityAuditLog.id));
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      action: 'user.password_reset_link_sent_by_admin',
      actorUserId: adminId,
      targetUserId: targetWithEmailId,
    });
    // Metadata must carry enough to identify the target after-the-fact
    // but NOT the full email address (which already lives on the user
    // row and would be redundant PII in the audit log).
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.targetUsername).toBe(TARGET_WITH_EMAIL);
    expect(meta.targetEmailDomain).toBe('example.test');
    expect(JSON.stringify(meta)).not.toContain(TARGET_EMAIL);
  });

  it('rotates a previously issued unused token instead of leaving two valid links outstanding', async () => {
    const cookie = await loginAs(ADMIN);
    vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined as unknown as void);

    const a = await jsonReq(
      `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );
    const b = await jsonReq(
      `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const tokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, targetWithEmailId));
    // Two rows exist (the old one is marked used, not deleted), but
    // exactly one is still redeemable.
    expect(tokens.length).toBe(2);
    const unused = tokens.filter((t) => t.usedAt === null);
    expect(unused.length).toBe(1);
  });

  it('400 with a clear error when the target has no recovery email — no token issued, no email sent, but one audit row is written', async () => {
    const cookie = await loginAs(ADMIN);
    const sendSpy = vi.spyOn(emailService, 'sendEmail');

    const r = await jsonReq(
      `${baseUrl}/api/auth/users/${targetNoEmailId}/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );

    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    // Operator-friendly message — we want them to know the next step.
    expect(r.body.error.toLowerCase()).toContain('email');

    expect(sendSpy).not.toHaveBeenCalled();
    const tokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, targetNoEmailId));
    expect(tokens.length).toBe(0);
    // Audit-on-every-call: a compromised admin probing user ids/emails
    // must leave a forensic trail even when the call fails.
    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminId));
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      action: 'user.password_reset_link_sent_by_admin',
      actorUserId: adminId,
      targetUserId: targetNoEmailId,
    });
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.success).toBe(false);
    expect(meta.errorCode).toBe('VALIDATION_ERROR');
  });

  it('404 + one failure audit row when the target id is unknown', async () => {
    const cookie = await loginAs(ADMIN);
    const sendSpy = vi.spyOn(emailService, 'sendEmail');

    const r = await jsonReq(
      `${baseUrl}/api/auth/users/999999999/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );
    expect(r.status).toBe(404);
    expect(sendSpy).not.toHaveBeenCalled();

    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminId));
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      action: 'user.password_reset_link_sent_by_admin',
      actorUserId: adminId,
      targetUserId: 999999999,
    });
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.success).toBe(false);
    expect(meta.errorCode).toBe('NOT_FOUND');
  });

  it('400 + one failure audit row when the :id path param is not numeric', async () => {
    const cookie = await loginAs(ADMIN);
    const r = await jsonReq(
      `${baseUrl}/api/auth/users/not-a-number/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );
    expect(r.status).toBe(400);

    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminId));
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      action: 'user.password_reset_link_sent_by_admin',
      actorUserId: adminId,
      // No numeric target id was resolvable — column is nullable for
      // exactly this case (admin passed garbage in the URL).
      targetUserId: null,
    });
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.success).toBe(false);
    expect(meta.errorCode).toBe('INVALID_USER_ID');
    expect(meta.rawTargetId).toBe('not-a-number');
  });

  it('surfaces a 502 EXTERNAL_SERVICE_ERROR when SendGrid throws — failure audit row is written, partial token row is left in place by design', async () => {
    const cookie = await loginAs(ADMIN);
    vi.spyOn(emailService, 'sendEmail').mockRejectedValue(
      new Error('SendGrid: 503 Service Unavailable'),
    );

    const r = await jsonReq(
      `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
      'POST',
      undefined,
      cookie,
    );

    // adminSendPasswordReset wraps raw transport errors as
    // ExternalServiceError so the operator gets a typed 502 with an
    // actionable message instead of a generic sanitized 500.
    expect(r.status).toBe(502);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.code).toBe('PASSWORD_RESET_EMAIL_SEND_FAILED');

    // Audit row is still written so a SendGrid outage produces a
    // forensic record of every attempted send.
    const audit = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, adminId));
    expect(audit.length).toBe(1);
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta.success).toBe(false);
    expect(meta.errorCode).toBe('PASSWORD_RESET_EMAIL_SEND_FAILED');
  });

  it('is NOT mounted behind the public 3/hr/IP password-reset limiter — admins can send a 4th reset within an hour from one IP', async () => {
    const cookie = await loginAs(ADMIN);
    vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined as unknown as void);
    const fixedIp = '198.51.100.250';

    // Four sends in a row from the same IP — the public endpoint
    // would 429 on the 4th. The admin endpoint must not.
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await jsonReq(
        `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
        'POST',
        undefined,
        cookie,
        fixedIp,
      );
      expect(r.status).toBe(200);
    }
  });
});
