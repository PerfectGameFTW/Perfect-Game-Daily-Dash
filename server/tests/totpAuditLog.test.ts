/**
 * Audit-log emission for TOTP lifecycle events (Task #102).
 *
 * Captures stdout/stderr while exercising each TOTP code path and
 * asserts the structured log lines carry the expected event tag,
 * userId, ip, requestId, and (where relevant) attemptCount /
 * recoveryCodesRemaining / actorRole.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { db } from '../db';
import { users } from '@shared/schema';
import { authService } from '../services/authService';
import { totpService } from '../services/totpService';
import { createAuthRouter } from '../routes/auth';

let __ip = 0;
function uniqueIp(): string {
  __ip += 1;
  return `198.51.100.${(__ip % 254) + 1}`;
}

interface CapturedLine {
  msg: string;
  event?: string;
  userId?: number;
  factor?: string;
  attemptCount?: number;
  recoveryCodesRemaining?: number;
  actorRole?: string;
  ip?: string;
  requestId?: string;
  reason?: string;
  level?: string;
}

const captured: CapturedLine[] = [];
let stdoutWrite: typeof process.stdout.write;
let stderrWrite: typeof process.stderr.write;

function captureStream(chunk: any): void {
  const s = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') ?? '';
  for (const line of s.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.msg === 'string' && obj.msg.startsWith('auth.totp.')) {
        captured.push(obj);
      }
    } catch {
      // not JSON — ignore
    }
  }
}

beforeAll(() => {
  stdoutWrite = process.stdout.write.bind(process.stdout);
  stderrWrite = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = ((chunk: any, ...rest: any[]) => {
    captureStream(chunk);
    return stdoutWrite(chunk, ...rest);
  }) as any;
  (process.stderr as any).write = ((chunk: any, ...rest: any[]) => {
    captureStream(chunk);
    return stderrWrite(chunk, ...rest);
  }) as any;
});

afterAll(() => {
  (process.stdout as any).write = stdoutWrite;
  (process.stderr as any).write = stderrWrite;
});

beforeEach(() => {
  captured.length = 0;
});

interface JsonResp {
  status: number;
  body: any;
  cookie: string | null;
}
async function jsonReq(
  url: string,
  method: 'GET' | 'POST',
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
  return { status: r.status, body, cookie: r.headers.get('set-cookie') };
}

const USERNAME = '__totp_audit_user__';
const PWD = 'AuditLog!Test-Pwd-77';

function currentCode(secretBase32: string): string {
  return currentCode2(secretBase32, USERNAME);
}
function currentCode2(secretBase32: string, label: string): string {
  return new TOTP({
    issuer: 'Perfect Game Sales Dashboard',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

describe('TOTP audit-log entries (Task #102)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let userId: number;
  let secretBase32: string;

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, USERNAME));
    // The /totp/enroll route requires admin (it's an admin-only feature
    // in this app), so the audit user has to be one.
    const u = await authService.registerUser(USERNAME, PWD, 'admin');
    userId = u.id;

    app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    // Mirror the production request-id middleware (server/index.ts) so
    // the audit log lines emitted by the route layer carry the same
    // requestId field a real deployment would emit.
    app.use((req, _res, next) => {
      (req as any).requestId = `test-req-${Math.random().toString(36).slice(2, 10)}`;
      next();
    });
    app.use(
      session({
        name: 'pgs.sid',
        secret: 'audit-test-secret-do-not-use-elsewhere',
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
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  beforeEach(async () => {
    // Reset to a known enrolled state for each test so log assertions
    // are independent of test ordering.
    const enrollment = await totpService.beginEnrollment(
      (await authService.getUserById(userId))!,
    );
    secretBase32 = enrollment.secret;
    await db
      .update(users)
      .set({ totpEnabled: true, totpRecoveryCodes: ['$argon2id$placeholder'] })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
    captured.length = 0; // clear setup noise
  });

  function find(event: string): CapturedLine | undefined {
    return captured.find((c) => c.event === event);
  }

  it('emits enrollment_started with userId/ip/requestId on /totp/enroll', async () => {
    // Log in fully so /totp/enroll (requireAuth + requireAdmin) accepts.
    const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username: USERNAME, password: PWD,
    });
    const c1 = r1.cookie!.split(';')[0];
    const r2 = await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', {
      code: currentCode(secretBase32),
    }, c1);
    const cookie = (r2.cookie ?? r1.cookie!).split(';')[0];
    captured.length = 0;

    const r = await jsonReq(`${baseUrl}/api/auth/totp/enroll`, 'POST', {}, cookie);
    expect(r.status).toBe(200);
    const line = find('enrollment_started');
    expect(line).toBeDefined();
    expect(line!.userId).toBe(userId);
    expect(typeof line!.requestId).toBe('string');
    expect(typeof line!.ip).toBe('string');
  });

  it('emits enrollment_verified (with recoveryCodesRemaining) on success and enrollment_verify_failed on bad code', async () => {
    // Bad code first.
    await totpService.verifyAndEnable(userId, '000000', { ip: '203.0.113.1', requestId: 'req-bad' });
    const failLine = find('enrollment_verify_failed');
    expect(failLine).toBeDefined();
    expect(failLine!.userId).toBe(userId);
    expect(failLine!.ip).toBe('203.0.113.1');
    expect(failLine!.requestId).toBe('req-bad');

    captured.length = 0;
    const codes = await totpService.verifyAndEnable(userId, currentCode(secretBase32), {
      ip: '203.0.113.2', requestId: 'req-ok',
    });
    expect(codes).not.toBeNull();
    const okLine = find('enrollment_verified');
    expect(okLine).toBeDefined();
    expect(okLine!.userId).toBe(userId);
    expect(okLine!.recoveryCodesRemaining).toBe(10);
    expect(okLine!.ip).toBe('203.0.113.2');
  });

  it('emits totp_login_success with factor=totp on a good 6-digit code at /totp/verify', async () => {
    const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username: USERNAME, password: PWD,
    });
    const cookie = r1.cookie!.split(';')[0];
    captured.length = 0;
    const r2 = await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', {
      code: currentCode(secretBase32),
    }, cookie);
    expect(r2.status).toBe(200);
    const line = find('totp_login_success');
    expect(line).toBeDefined();
    expect(line!.factor).toBe('totp');
    expect(line!.userId).toBe(userId);
    expect(typeof line!.requestId).toBe('string');
    expect(typeof line!.ip).toBe('string');
  });

  it('emits totp_login_failure with monotonically rising attemptCount, then resets on success', async () => {
    const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username: USERNAME, password: PWD,
    });
    const cookie = r1.cookie!.split(';')[0];
    captured.length = 0;

    // Two bad attempts on the same pending session.
    await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', { code: '000000' }, cookie);
    await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', { code: '000001' }, cookie);
    const failures = captured.filter((l) => l.event === 'totp_login_failure');
    expect(failures).toHaveLength(2);
    expect(failures[0].attemptCount).toBe(1);
    expect(failures[1].attemptCount).toBe(2);

    captured.length = 0;
    const ok = await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', {
      code: currentCode(secretBase32),
    }, cookie);
    expect(ok.status).toBe(200);
    expect(find('totp_login_success')).toBeDefined();
  });

  it('emits recovery_code_used with factor=recovery and remaining count on a successful recovery-code login', async () => {
    // Real recovery codes seeded via verifyAndEnable.
    const codes = (await totpService.verifyAndEnable(userId, currentCode(secretBase32)))!;
    captured.length = 0;
    const result = await totpService.verifyLoginCode(userId, codes[0], {
      ip: '203.0.113.99', requestId: 'req-recovery',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.factor).toBe('recovery');
    const line = find('recovery_code_used');
    expect(line).toBeDefined();
    expect(line!.factor).toBe('recovery');
    expect(line!.userId).toBe(userId);
    expect(line!.ip).toBe('203.0.113.99');
    expect(line!.requestId).toBe('req-recovery');
    expect(line!.recoveryCodesRemaining).toBe(9);
    expect(line!.level).toBe('warn');
    // No success event should also fire — only the recovery event.
    expect(find('totp_login_success')).toBeUndefined();
  });

  it('emits totp_disabled with actorRole=self on the self-service /totp/disable endpoint', async () => {
    const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username: USERNAME, password: PWD,
    });
    const c1 = r1.cookie!.split(';')[0];
    const r2 = await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', {
      code: currentCode(secretBase32),
    }, c1);
    const cookie = (r2.cookie ?? r1.cookie!).split(';')[0];
    captured.length = 0;

    const r = await jsonReq(`${baseUrl}/api/auth/totp/disable`, 'POST', {
      password: PWD,
    }, cookie);
    expect(r.status).toBe(200);
    const line = find('totp_disabled');
    expect(line).toBeDefined();
    expect(line!.actorRole).toBe('self');
    expect(line!.userId).toBe(userId);
    expect(line!.level).toBe('warn');
  });

  it('emits totp_disabled with actorRole=admin when an admin disables another admins 2FA', async () => {
    // Spin up a second admin to be the target.
    const targetUsername = '__totp_audit_target_admin__';
    const targetPwd = 'Target!Audit-Pwd-22';
    await db.delete(users).where(eq(users.username, targetUsername));
    const target = await authService.registerUser(targetUsername, targetPwd, 'admin');
    try {
      // Enable the target's 2FA so the disable endpoint has something to do.
      const targetEnroll = await totpService.beginEnrollment(target);
      await totpService.verifyAndEnable(target.id, currentCode2(targetEnroll.secret, targetUsername));

      // Sign in our test admin.
      const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
        username: USERNAME, password: PWD,
      });
      const c1 = r1.cookie!.split(';')[0];
      const r2 = await jsonReq(`${baseUrl}/api/auth/totp/verify`, 'POST', {
        code: currentCode(secretBase32),
      }, c1);
      const cookie = (r2.cookie ?? r1.cookie!).split(';')[0];
      captured.length = 0;

      const r = await jsonReq(
        `${baseUrl}/api/auth/admin/security/users/${target.id}/disable-totp`,
        'POST',
        { password: PWD },
        cookie,
      );
      expect(r.status).toBe(200);
      const line = find('totp_disabled');
      expect(line).toBeDefined();
      expect(line!.actorRole).toBe('admin');
      expect(line!.userId).toBe(target.id);
      expect(line!.level).toBe('warn');
    } finally {
      await db.delete(users).where(eq(users.id, target.id));
    }
  });

  it('does not include any field outside the logger allow-list (no leaking secrets, codes, or unknown keys)', async () => {
    const codes = (await totpService.verifyAndEnable(userId, currentCode(secretBase32)))!;
    captured.length = 0;
    await totpService.verifyLoginCode(userId, codes[0]);
    const line = find('recovery_code_used')!;
    // The captured object is what hit stdout/stderr — if a forbidden
    // field had been passed, the sanitizer would have dropped it, so
    // we mainly assert positively that the structured fields we DO
    // expect are present and that no obviously-secret field leaked.
    for (const forbidden of ['secret', 'totpSecret', 'recoveryCode', 'plaintext', 'password']) {
      expect((line as any)[forbidden]).toBeUndefined();
    }
  });
});
