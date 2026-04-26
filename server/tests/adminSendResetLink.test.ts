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

import { db, pool } from '../db';
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
  // The admin actor is TOTP-enrolled, so a successful login goes through
  // the two-step flow and (since Task #131) writes a totp.login_success
  // row to security_audit_log. The per-test audit-row counts here only
  // care about password-reset rows, so we log in EXACTLY ONCE per suite,
  // cache the cookie, and let beforeEach scrub the login_success row
  // along with any prior reset rows before each assertion.
  let adminCookie: string | null = null;
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

    // Pre-warm the admin's authenticated cookie BEFORE any test runs so
    // the very first beforeEach (which scrubs every row for the admin
    // actor) also clears the totp.login_success row. If we let the
    // first test trigger the login, that row would land between
    // beforeEach's scrub and the test's audit-count assertion and
    // inflate the count by one. See `adminCookie` for the cache.
    await loginAs(ADMIN);
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
    // Reuse the cached admin cookie when possible: re-running the login
    // flow per test would write a fresh totp.login_success row mid-test
    // and break the per-test audit-row count assertions (Task #131).
    // Server-side sessions persist across the suite — there's no logout
    // or session destroy in beforeEach — so the cached cookie stays
    // valid for the lifetime of the suite.
    if (username === ADMIN && adminCookie) return adminCookie;

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
    if (username === ADMIN) adminCookie = cookie;
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

  // Task #127: success case must purge the target's active sessions.
  // Operator threat model: a reset link gets sent because the target's
  // account is suspect (post-compromise help-desk ticket, hijacked
  // admin, etc). If the attacker is currently signed in, leaving their
  // session alive until the user follows the email link defeats the
  // operator's intervention. Failure cases (no email on file, transport
  // failure, unknown user) must NOT purge — there's no actual security
  // remediation in flight.
  describe('Task #127: session revocation on send-reset-link', () => {
    const TARGET_SID_OK = '__t127_resend_ok__';
    const TARGET_SID_NOEMAIL = '__t127_resend_noemail__';
    const TARGET_SID_TRANSPORT = '__t127_resend_transport__';
    const OTHER_SID = '__t127_resend_other__';

    async function seedSession(sid: string, userId: number): Promise<void> {
      const expire = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::json, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, JSON.stringify({ userId, cookie: {} }), expire],
      );
    }
    async function sessionExists(sid: string): Promise<boolean> {
      const r = await pool.query<{ sid: string }>(
        'SELECT sid FROM sessions WHERE sid = $1',
        [sid],
      );
      return r.rowCount! > 0;
    }

    beforeAll(async () => {
      // Tests in this file run against an in-memory express-session
      // store so the connect-pg-simple `sessions` table is never
      // auto-created here. Materialize it ourselves with the same
      // schema connect-pg-simple uses so the route's DELETE statement
      // has something to operate on.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid VARCHAR PRIMARY KEY,
          sess JSON NOT NULL,
          expire TIMESTAMP(6) NOT NULL
        )
      `);
    });

    afterAll(async () => {
      await pool.query(
        `DELETE FROM sessions WHERE sid IN ($1, $2, $3, $4)`,
        [TARGET_SID_OK, TARGET_SID_NOEMAIL, TARGET_SID_TRANSPORT, OTHER_SID],
      );
    });

    it('destroys every active session for the target — and only the target — on a successful send', async () => {
      vi.spyOn(emailService, 'sendEmail').mockResolvedValue(
        undefined as unknown as void,
      );
      await seedSession(TARGET_SID_OK, targetWithEmailId);
      await seedSession(OTHER_SID, normalUserId);
      expect(await sessionExists(TARGET_SID_OK)).toBe(true);
      expect(await sessionExists(OTHER_SID)).toBe(true);

      const cookie = await loginAs(ADMIN);
      const r = await jsonReq(
        `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
        'POST',
        undefined,
        cookie,
      );
      expect(r.status).toBe(200);

      // Target sessions wiped; unrelated user's session preserved.
      expect(await sessionExists(TARGET_SID_OK)).toBe(false);
      expect(await sessionExists(OTHER_SID)).toBe(true);
    });

    it('does NOT revoke sessions when the target has no recovery email (no security action taken)', async () => {
      // No email on file → 400 before any reset/security-state change.
      // Purging here would be a denial-of-service vector: an admin
      // with the user-management permission could log out any account
      // by trying to send a reset link, even when no link actually
      // gets issued.
      vi.spyOn(emailService, 'sendEmail');
      await seedSession(TARGET_SID_NOEMAIL, targetNoEmailId);
      expect(await sessionExists(TARGET_SID_NOEMAIL)).toBe(true);

      const cookie = await loginAs(ADMIN);
      const r = await jsonReq(
        `${baseUrl}/api/auth/users/${targetNoEmailId}/send-reset-link`,
        'POST',
        undefined,
        cookie,
      );
      expect(r.status).toBe(400);
      expect(await sessionExists(TARGET_SID_NOEMAIL)).toBe(true);
    });

    it('does NOT revoke any session when the target id is unknown (404 path)', async () => {
      // Prove the purge SQL doesn't fire on the validation-failure
      // path. Seed a session for a real, unrelated user and call
      // send-reset-link with an ID that has never existed; the row
      // must survive. Otherwise an admin who fat-fingers a target ID
      // could DoS a random other account.
      vi.spyOn(emailService, 'sendEmail');
      await seedSession(OTHER_SID, normalUserId);
      expect(await sessionExists(OTHER_SID)).toBe(true);

      const cookie = await loginAs(ADMIN);
      const r = await jsonReq(
        `${baseUrl}/api/auth/users/9999999/send-reset-link`,
        'POST',
        undefined,
        cookie,
      );
      expect(r.status).toBe(404);
      expect(await sessionExists(OTHER_SID)).toBe(true);
    });

    it('does NOT revoke sessions when SendGrid throws (no link delivered)', async () => {
      vi.spyOn(emailService, 'sendEmail').mockRejectedValue(
        new Error('SendGrid: 503 Service Unavailable'),
      );
      await seedSession(TARGET_SID_TRANSPORT, targetWithEmailId);
      expect(await sessionExists(TARGET_SID_TRANSPORT)).toBe(true);

      const cookie = await loginAs(ADMIN);
      const r = await jsonReq(
        `${baseUrl}/api/auth/users/${targetWithEmailId}/send-reset-link`,
        'POST',
        undefined,
        cookie,
      );
      // Transport failure surfaces as 502 — purging on this branch
      // would log the user out without ever sending them a recovery
      // link, locking them out of the account.
      expect(r.status).toBe(502);
      expect(await sessionExists(TARGET_SID_TRANSPORT)).toBe(true);
    });
  });
});
