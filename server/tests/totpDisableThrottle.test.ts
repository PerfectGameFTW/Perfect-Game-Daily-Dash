import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import {
  totpDisableAccountLimiter,
  totpDisableIpLimiter,
} from '../middleware/rateLimiter';

// Per-IP source isolation: each non-throttle assertion uses a unique
// IP so unrelated tests in this file can't accidentally share an IP
// bucket. Throttle-targeted tests below pin a specific IP and reset
// it explicitly before/after the loop.
let __ip = 0;
function uniqueIp(): string {
  __ip += 1;
  return `192.0.2.${(__ip % 254) + 1}`;
}

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
  ipOverride?: string,
): Promise<JsonResp> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ipOverride ?? uniqueIp(),
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

const USERNAME = '__totp_disable_throttle_user__';
const PWD = 'Disable!Throttle-Test-Pwd-77';

function currentCode(secretBase32: string): string {
  const totp = new TOTP({
    issuer: 'Perfect Game Sales Dashboard',
    label: USERNAME,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.generate();
}

describe('Throttle the self-disable-2FA endpoint (Task #174)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let userId: number;
  let secretBase32: string;

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, USERNAME));
    const u = await authService.registerUser(USERNAME, PWD, 'admin');
    userId = u.id;

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
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  beforeEach(async () => {
    // Each test mutates the user's TOTP state (a successful disable
    // clears it; the loops below also rack up failed-login counters).
    // Re-enroll a fresh secret + clear lockout state so tests can
    // run in any order without leaning on prior state.
    const enrollment = await totpService.beginEnrollment({
      ...(await authService.getUserById(userId))!,
    } as any);
    secretBase32 = enrollment.secret;
    await db
      .update(users)
      .set({
        totpEnabled: true,
        totpRecoveryCodes: ['$argon2id$placeholder'],
        // The throttle tests below intentionally exceed the
        // 5-strike password-lockout threshold while draining the
        // 10/15-min rate-limit bucket. Without clearing this
        // between tests the second test would already be locked
        // out before its first request and never reach the limiter.
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
    // Also reset the per-account throttle bucket so a previous
    // test that drained it doesn't leave the next test pre-throttled.
    // Per-IP buckets are naturally isolated by uniqueIp() in jsonReq.
    totpDisableAccountLimiter.resetKey(`acct:${userId}`);
  });

  // Drains the per-account password-lockout state so a tight loop
  // of wrong-password requests can exercise the rate limiter without
  // tripping the unrelated lockout-after-5-failures defense and
  // changing the response shape from 401 to a different failure.
  async function resetAccountLockout(): Promise<void> {
    await db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
  }

  async function login(): Promise<string> {
    const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username: USERNAME,
      password: PWD,
    });
    expect(r1.body.requiresTotp).toBe(true);
    const cookie = r1.cookie!.split(';')[0];
    const r2 = await jsonReq(
      `${baseUrl}/api/auth/totp/verify`,
      'POST',
      { code: currentCode(secretBase32) },
      cookie,
    );
    expect(r2.status).toBe(200);
    return (r2.cookie ?? r1.cookie!).split(';')[0];
  }

  // Each /totp/disable request runs a deliberately-slow bcrypt.compare
  // (via loginUser) plus a Neon DB write; this loop fires ~11 of them
  // sequentially. The default 5s timeout is too tight under full-suite
  // CPU contention (many parallel forks competing for bcrypt cycles),
  // so give the throttle-loop tests a generous explicit budget.
  it('throttles with 429 after 10 failed attempts from the same IP', { timeout: 30000 }, async () => {
    const cookie = await login();
    const ATTACKER_IP = '198.51.100.71';
    // Reset both buckets so prior tests / unique-IP traffic in this
    // file don't poison the per-account counter.
    totpDisableIpLimiter.resetKey(`ip:${ATTACKER_IP}`);
    totpDisableAccountLimiter.resetKey(`acct:${userId}`);

    // 10 failed attempts (wrong password) all return 401 — the
    // budget for this IP is exactly 10, mirroring the regenerate
    // throttle. We reset the per-account password-lockout state
    // between attempts so the unrelated lockout-after-5-failures
    // defense doesn't flip the response code from 401 mid-loop.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/disable`,
        'POST',
        { password: 'definitely-not-the-password' },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // 11th attempt from the same IP is throttled — the limiter
    // runs before the route handler, so even a correct password
    // would be blocked here. We send the REAL password to make
    // that point loudly: a brute-forcer who happened to land on
    // the right credential as their 11th guess would still be
    // told 429, never succeed at flipping 2FA off.
    await resetAccountLockout();
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/disable`,
      'POST',
      { password: PWD },
      cookie,
      ATTACKER_IP,
    );
    expect(blocked.status).toBe(429);

    // Confirm 2FA is still on — the throttled request must NOT
    // have made it into the disable code path. If the limiter
    // were removed or wired AFTER the handler, this would flip
    // to false because the supplied password was correct.
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpEnabled).toBe(true);
  });

  it('throttle bucket clears after a successful disable', { timeout: 30000 }, async () => {
    const cookie = await login();
    const ATTACKER_IP = '198.51.100.74';
    totpDisableIpLimiter.resetKey(`ip:${ATTACKER_IP}`);
    totpDisableAccountLimiter.resetKey(`acct:${userId}`);

    // Burn 9 of the 10 attempts on bad passwords.
    for (let i = 0; i < 9; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/disable`,
        'POST',
        { password: 'definitely-not-the-password' },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // One successful disable. The route calls resetKey() on
    // success which fully clears both the per-IP and per-account
    // buckets — proven by the second 10-strike loop below.
    await resetAccountLockout();
    const ok = await jsonReq(
      `${baseUrl}/api/auth/totp/disable`,
      'POST',
      { password: PWD },
      cookie,
      ATTACKER_IP,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    // Sanity: 2FA actually went off.
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpEnabled).toBe(false);

    // After the success, we should be able to make a fresh batch
    // of 10 failed attempts without hitting 429 — proof the
    // bucket was cleared, not just decremented by one. (The
    // success put the counter at 9; without resetKey() the very
    // next failed attempt would already trip the limit.)
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/disable`,
        'POST',
        { password: 'definitely-not-the-password' },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // And the 11th still throttles — the limiter is still
    // functional, it just got a clean reset by the prior success.
    await resetAccountLockout();
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/disable`,
      'POST',
      { password: PWD },
      cookie,
      ATTACKER_IP,
    );
    expect(blocked.status).toBe(429);
  });

  it('throttles per-account even when failed attempts come from many IPs', { timeout: 30000 }, async () => {
    const cookie = await login();
    // Reset the per-account bucket so prior tests don't interfere.
    totpDisableAccountLimiter.resetKey(`acct:${userId}`);

    // 10 failed attempts spread across 10 different IPs. The
    // per-IP limiter never trips (each IP is at 1/10), but the
    // per-account limiter sees all 10 hits against the same userId.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const ip = `203.0.113.${i + 1}`;
      totpDisableIpLimiter.resetKey(`ip:${ip}`);
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/disable`,
        'POST',
        { password: 'definitely-not-the-password' },
        cookie,
        ip,
      );
      expect(r.status).toBe(401);
    }

    // 11th attempt from yet another fresh IP is blocked by the
    // per-account limiter even though that IP has never hit this
    // endpoint before. Without the second limiter (per-account),
    // a botnet could spread attempts across IPs and brute-force
    // the password gate without ever tripping a bucket.
    await resetAccountLockout();
    const freshIp = '203.0.113.250';
    totpDisableIpLimiter.resetKey(`ip:${freshIp}`);
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/disable`,
      'POST',
      { password: PWD },
      cookie,
      freshIp,
    );
    expect(blocked.status).toBe(429);

    // 2FA still on — no disable made it through.
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpEnabled).toBe(true);
  });
});
