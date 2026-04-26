/**
 * Coverage for GET /api/auth/admin/security/totp-alerts (Task #177).
 *
 * The endpoint is the in-product surface for the TOTP brute-force /
 * recovery-code-burst alerter (Task #132). It reads aggregated rows
 * from `security_audit_log` so the panel persists across server
 * restarts and shows the same set of accounts the in-process webhook
 * would have fired on. Tests assert:
 *   - Auth-gated (401 anonymous, 403 non-admin).
 *   - Brute-force aggregation: groups by target_user_id, counts
 *     events in the window, surfaces peak attemptCount, respects
 *     the threshold (count OR single-event tripwire).
 *   - Recovery-burst aggregation: groups + counts, threshold gates.
 *   - Window cutoff: events older than windowMs are excluded.
 *   - Defaults track the alerter's config when no query params
 *     are supplied; query params override them.
 *   - Response echoes the resolved window/thresholds for the UI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { inArray } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { db } from '../db';
import { users, securityAuditLog } from '@shared/schema';
import { authService } from '../services/authService';
import { totpService } from '../services/totpService';
import { totpAuthAlerter } from '../services/totpAuthAlert';
import { createAuthRouter } from '../routes/auth';

let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  return `198.51.100.${(__ipCounter % 254) + 1}`;
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
  return { status: r.status, body, cookie: r.headers.get('set-cookie') };
}

const ADMIN_USERNAME = '__totp_alerts_admin__';
const NORMAL_USERNAME = '__totp_alerts_user__';
const VICTIM_A = '__totp_alerts_victim_a__';
const VICTIM_B = '__totp_alerts_victim_b__';
const VICTIM_C = '__totp_alerts_victim_c__';
const PWD = 'TotpAlerts-Test-Pwd-99';

function currentCode(secretBase32: string, label: string): string {
  return new TOTP({
    issuer: 'Perfect Game Sales Dashboard',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

describe('GET /admin/security/totp-alerts (Task #177)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let normalUserId: number;
  let victimAId: number;
  let victimBId: number;
  let victimCId: number;
  let adminTotpSecret: string;
  let adminCookie: string | null = null;

  beforeAll(async () => {
    await db.delete(users).where(inArray(users.username, [
      ADMIN_USERNAME, NORMAL_USERNAME, VICTIM_A, VICTIM_B, VICTIM_C,
    ]));
    const a = await authService.registerUser(ADMIN_USERNAME, PWD, 'admin');
    adminId = a.id;
    const u = await authService.registerUser(NORMAL_USERNAME, PWD, 'user');
    normalUserId = u.id;
    const va = await authService.registerUser(VICTIM_A, PWD, 'admin');
    victimAId = va.id;
    const vb = await authService.registerUser(VICTIM_B, PWD, 'admin');
    victimBId = vb.id;
    const vc = await authService.registerUser(VICTIM_C, PWD, 'user');
    victimCId = vc.id;

    adminTotpSecret = (
      await totpService.beginEnrollment(a, { ip: '127.0.0.1' })
    ).secret;
    await totpService.verifyAndEnable(
      adminId,
      currentCode(adminTotpSecret, ADMIN_USERNAME),
      { ip: '127.0.0.1' },
    );

    // Pin the alerter config to known defaults so tests don't depend
    // on whatever env vars happen to be present in CI.
    totpAuthAlerter.reset();
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: null,
        failureThreshold: 5,
        recoveryThreshold: 3,
        windowMs: 15 * 60 * 1000,
        cooldownMs: 60 * 60 * 1000,
      },
    });

    app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use(session({
      name: 'pgs.sid',
      secret: 'test-secret-do-not-use-elsewhere',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false },
    }));
    app.use('/api/auth', createAuthRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await login(ADMIN_USERNAME);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db
      .delete(securityAuditLog)
      .where(inArray(securityAuditLog.targetUserId, [adminId, victimAId, victimBId, victimCId]));
    await db
      .delete(users)
      .where(inArray(users.id, [adminId, normalUserId, victimAId, victimBId, victimCId]));
    totpAuthAlerter.reset();
  });

  beforeEach(async () => {
    // Wipe any audit rows targeting the test victims before each
    // test so cross-test leakage from sibling test files (or earlier
    // assertions in this file) cannot skew row counts.
    await db
      .delete(securityAuditLog)
      .where(inArray(securityAuditLog.targetUserId, [adminId, victimAId, victimBId, victimCId]));
  });

  async function login(username: string): Promise<string> {
    if (username === ADMIN_USERNAME && adminCookie) return adminCookie;
    const r = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', { username, password: PWD });
    expect(r.status).toBe(200);
    let cookie = r.cookie!.split(';')[0];
    if (r.body?.requiresTotp) {
      const v = await jsonReq(
        `${baseUrl}/api/auth/totp/verify`,
        'POST',
        { code: currentCode(adminTotpSecret, ADMIN_USERNAME) },
        cookie,
      );
      expect(v.status).toBe(200);
      if (v.cookie) cookie = v.cookie.split(';')[0];
    }
    if (username === ADMIN_USERNAME) adminCookie = cookie;
    return cookie;
  }

  async function seedFailure(
    userId: number,
    attemptCount: number,
    createdAt?: Date,
  ): Promise<void> {
    await db.insert(securityAuditLog).values({
      actorUserId: userId,
      actorIp: '10.0.0.1',
      action: 'totp.login_failure',
      targetUserId: userId,
      metadata: {
        event: 'totp_login_failure',
        attemptCount,
      },
      ...(createdAt ? { createdAt } : {}),
    });
  }

  async function seedRecoveryUse(
    userId: number,
    createdAt?: Date,
  ): Promise<void> {
    await db.insert(securityAuditLog).values({
      actorUserId: userId,
      actorIp: '10.0.0.1',
      action: 'totp.recovery_code_used',
      targetUserId: userId,
      metadata: {
        event: 'recovery_code_used',
        factor: 'recovery',
      },
      ...(createdAt ? { createdAt } : {}),
    });
  }

  it('rejects anonymous requests with 401', async () => {
    const r = await jsonReq(`${baseUrl}/api/auth/admin/security/totp-alerts`, 'GET');
    expect(r.status).toBe(401);
  });

  it('rejects non-admins with 403', async () => {
    const cookie = await login(NORMAL_USERNAME);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(403);
  });

  it('aggregates brute-force failures per account when count crosses the threshold', async () => {
    // 5 failures on victim A — exactly at the count threshold.
    for (let i = 1; i <= 5; i++) await seedFailure(victimAId, i);
    // 3 failures on victim B — under the count threshold and no
    // single attemptCount above it. Should NOT appear.
    for (let i = 1; i <= 3; i++) await seedFailure(victimBId, i);

    const cookie = await login(ADMIN_USERNAME);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.failureThreshold).toBe(5);
    expect(r.body.recoveryThreshold).toBe(3);
    const victimAEntry = r.body.bruteForce.find((e: any) => e.userId === victimAId);
    expect(victimAEntry).toBeDefined();
    expect(victimAEntry.username).toBe(VICTIM_A);
    expect(victimAEntry.failureCount).toBe(5);
    expect(victimAEntry.peakAttemptCount).toBe(5);
    const victimBEntry = r.body.bruteForce.find((e: any) => e.userId === victimBId);
    expect(victimBEntry).toBeUndefined();
  });

  it('triggers brute-force alert when a single event reports attemptCount >= threshold', async () => {
    // Only one failure but with attemptCount of 7 — the single-event
    // tripwire mirrors the alerter's webhook behavior (a stolen
    // pending cookie may produce one log line carrying a high count
    // before being throttled).
    await seedFailure(victimAId, 7);

    const cookie = await login(ADMIN_USERNAME);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    const entry = r.body.bruteForce.find((e: any) => e.userId === victimAId);
    expect(entry).toBeDefined();
    expect(entry.failureCount).toBe(1);
    expect(entry.peakAttemptCount).toBe(7);
  });

  it('aggregates recovery-code burst per account when count crosses the threshold', async () => {
    for (let i = 0; i < 3; i++) await seedRecoveryUse(victimAId);
    // Two uses on victim B — under threshold, should not appear.
    for (let i = 0; i < 2; i++) await seedRecoveryUse(victimBId);

    const cookie = await login(ADMIN_USERNAME);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    const a = r.body.recoveryBurst.find((e: any) => e.userId === victimAId);
    expect(a).toBeDefined();
    expect(a.username).toBe(VICTIM_A);
    expect(a.recoveryCount).toBe(3);
    expect(a.firstEventAt).toBeDefined();
    expect(a.lastEventAt).toBeDefined();
    const b = r.body.recoveryBurst.find((e: any) => e.userId === victimBId);
    expect(b).toBeUndefined();
  });

  it('excludes events older than the window from the aggregation', async () => {
    // Five failures all stamped 1 hour ago; the default window is
    // 15 minutes so none of them should count.
    const oldTs = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 1; i <= 5; i++) await seedFailure(victimCId, i, oldTs);

    const cookie = await login(ADMIN_USERNAME);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    const entry = r.body.bruteForce.find((e: any) => e.userId === victimCId);
    expect(entry).toBeUndefined();

    // But widening the window to 2 hours via query param should
    // surface them.
    const r2 = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts?windowMs=${2 * 60 * 60 * 1000}`,
      'GET',
      undefined,
      cookie,
    );
    expect(r2.status).toBe(200);
    expect(r2.body.windowMs).toBe(2 * 60 * 60 * 1000);
    const entry2 = r2.body.bruteForce.find((e: any) => e.userId === victimCId);
    expect(entry2).toBeDefined();
    expect(entry2.failureCount).toBe(5);
  });

  it('respects custom failureThreshold/recoveryThreshold query parameters', async () => {
    // 3 failures on victim B — below default threshold of 5 but
    // above a custom threshold of 3.
    for (let i = 1; i <= 3; i++) await seedFailure(victimBId, i);

    const cookie = await login(ADMIN_USERNAME);

    // Default threshold: not surfaced.
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.bruteForce.find((e: any) => e.userId === victimBId)).toBeUndefined();

    // Custom threshold: surfaced.
    const r2 = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts?failureThreshold=3`,
      'GET',
      undefined,
      cookie,
    );
    expect(r2.status).toBe(200);
    expect(r2.body.failureThreshold).toBe(3);
    const entry = r2.body.bruteForce.find((e: any) => e.userId === victimBId);
    expect(entry).toBeDefined();
    expect(entry.failureCount).toBe(3);
  });

  it('rejects malformed query parameters with 400', async () => {
    const cookie = await login(ADMIN_USERNAME);
    // Window way too large — must be capped at 24h.
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts?windowMs=${365 * 24 * 60 * 60 * 1000}`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(400);
  });

  it('echoes back resolved window and thresholds plus a server timestamp', async () => {
    const cookie = await login(ADMIN_USERNAME);
    const r = await jsonReq(
      `${baseUrl}/api/auth/admin/security/totp-alerts`,
      'GET',
      undefined,
      cookie,
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.windowMs).toBe('number');
    expect(typeof r.body.failureThreshold).toBe('number');
    expect(typeof r.body.recoveryThreshold).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
    expect(Array.isArray(r.body.bruteForce)).toBe(true);
    expect(Array.isArray(r.body.recoveryBurst)).toBe(true);
  });
});
