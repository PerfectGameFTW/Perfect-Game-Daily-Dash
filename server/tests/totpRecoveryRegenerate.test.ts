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
import { decryptTotpSecret } from '../services/totpCrypto';
import { verifyPassword } from '../services/passwordHash';
import {
  totpRecoveryRegenerateAccountLimiter,
  totpRecoveryRegenerateIpLimiter,
} from '../middleware/rateLimiter';

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

const USERNAME = '__totp_regen_user__';
const PWD = 'Regen!Codes-Test-Pwd-44';

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

describe('Regenerate TOTP recovery codes (Task #101)', () => {
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
    // Fresh enrollment for every test: begin → flip totpEnabled true and
    // seed a known recovery batch we can later assert is wiped.
    const enrollment = await totpService.beginEnrollment({
      ...(await authService.getUserById(userId))!,
    } as any);
    secretBase32 = enrollment.secret;
    await db
      .update(users)
      .set({
        totpEnabled: true,
        totpRecoveryCodes: ['$argon2id$placeholder'],
        // Clear any per-account lockout state left over from a previous
        // test that hit loginUser with a wrong password — the throttle
        // tests below intentionally exceed the 5-strike lockout
        // threshold to drain the rate-limit bucket.
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
    // Reset the regenerate-throttle bucket for this user so a previous
    // test that drained it doesn't leave the next test pre-throttled.
    // Per-IP buckets are naturally isolated by uniqueIp() in jsonReq.
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);
  });

  // Drains the per-account password-lockout state so a tight loop of
  // wrong-password requests can exercise the rate limiter without
  // tripping the unrelated lockout-after-5-failures defense.
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
    // The verify response usually rotates the cookie — use whichever
    // value the server hands back.
    return (r2.cookie ?? r1.cookie!).split(';')[0];
  }

  it('returns 10 fresh codes and rotates the stored hash batch when password + TOTP are correct', async () => {
    const cookie = await login();
    const before = await db.select().from(users).where(eq(users.id, userId));
    const oldHashes = before[0]?.totpRecoveryCodes ?? [];

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(Array.isArray(r.body.recoveryCodes)).toBe(true);
    expect(r.body.recoveryCodes).toHaveLength(10);
    // Format: XXXXX-XXXXX with the Crockford-ish alphabet.
    for (const c of r.body.recoveryCodes) {
      expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }

    const after = await db.select().from(users).where(eq(users.id, userId));
    const newHashes = after[0]?.totpRecoveryCodes ?? [];
    expect(newHashes).toHaveLength(10);
    // None of the new hashes should match any of the old ones.
    for (const h of newHashes) {
      expect(oldHashes).not.toContain(h);
    }
    // And the new plaintext should verify against the new hashes (one
    // each, in some order).
    for (const code of r.body.recoveryCodes as string[]) {
      const stripped = code.replace('-', '');
      // eslint-disable-next-line no-await-in-loop
      const matches = await Promise.all(newHashes.map((h) => verifyPassword(stripped, h)));
      expect(matches.filter(Boolean)).toHaveLength(1);
    }
    // totpLastUsedAt should have been refreshed.
    expect(after[0]?.totpLastUsedAt).toBeTruthy();
  });

  it('previous recovery codes stop working as soon as the batch is regenerated', { timeout: 20000 }, async () => {
    const cookie = await login();
    // Seed one known recovery code by enrolling the proper way.
    const verifyResult = await totpService.verifyAndEnable(userId, currentCode(secretBase32));
    expect(verifyResult).not.toBeNull();
    const oldCodes = verifyResult!;
    // Sanity: the seeded code verifies.
    expect((await totpService.verifyLoginCode(userId, oldCodes[0])).ok).toBe(true);
    // Re-seed a second usable code (the verify above consumed one).
    const verifyResult2 = await totpService.verifyAndEnable(userId, currentCode(secretBase32));
    const oldBatch = verifyResult2!;

    // Regenerate via the endpoint.
    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(200);

    // Every previously-issued code should now be rejected.
    for (const c of oldBatch) {
      // eslint-disable-next-line no-await-in-loop
      expect((await totpService.verifyLoginCode(userId, c)).ok).toBe(false);
    }
    // A code from the new batch should be accepted exactly once.
    const newCode = (r.body.recoveryCodes as string[])[0];
    expect((await totpService.verifyLoginCode(userId, newCode)).ok).toBe(true);
    expect((await totpService.verifyLoginCode(userId, newCode)).ok).toBe(false);
  });

  it('rejects with 401 when the password is wrong (and does not rotate codes)', async () => {
    const cookie = await login();
    const before = await db.select().from(users).where(eq(users.id, userId));

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(401);

    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(before[0]?.totpRecoveryCodes);
  });

  it('rejects when the TOTP code is wrong (and does not rotate codes)', async () => {
    const cookie = await login();
    const before = await db.select().from(users).where(eq(users.id, userId));

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: '000000' },
      cookie,
    );
    expect(r.status).toBe(400);

    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(before[0]?.totpRecoveryCodes);
  });

  it('rejects a recovery code in the TOTP slot — only live authenticator codes unlock regeneration', async () => {
    const cookie = await login();
    // Get a real plaintext recovery code via verifyAndEnable.
    const codes = (await totpService.verifyAndEnable(userId, currentCode(secretBase32)))!;
    const recoveryCode = codes[0];
    const before = await db.select().from(users).where(eq(users.id, userId));

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: recoveryCode },
      cookie,
    );
    expect(r.status).toBe(400);

    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(before[0]?.totpRecoveryCodes);
  });

  it('requires authentication', async () => {
    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
    );
    expect(r.status).toBe(401);
  });

  it('concurrent recovery-code consumption cannot resurrect old hashes after regeneration (FOR UPDATE serializes)', { timeout: 20000 }, async () => {
    const cookie = await login();
    // Seed two real recovery codes against the current batch.
    const oldBatch = (await totpService.verifyAndEnable(userId, currentCode(secretBase32)))!;
    expect(oldBatch.length).toBeGreaterThanOrEqual(2);

    // Race verifyLoginCode (with an old code) against the regenerate
    // endpoint. The lock guarantees one of two terminal states:
    //   (a) verify wins → its remove-one-hash write commits first,
    //       then regen overwrites with the brand-new batch.
    //   (b) regen wins → verify's read sees the new batch and the
    //       stale code is rejected.
    // In BOTH cases the final DB state must contain ONLY hashes for
    // the freshly returned codes — never any of the original hashes.
    const beforeRegen = await db.select().from(users).where(eq(users.id, userId));
    const oldHashes = beforeRegen[0]!.totpRecoveryCodes ?? [];

    const [verifyOutcome, regenResp] = await Promise.all([
      totpService.verifyLoginCode(userId, oldBatch[0]),
      jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: PWD, code: currentCode(secretBase32) },
        cookie,
      ),
    ]);
    expect(regenResp.status).toBe(200);
    const newCodes = regenResp.body.recoveryCodes as string[];

    const after = await db.select().from(users).where(eq(users.id, userId));
    const finalHashes = after[0]!.totpRecoveryCodes ?? [];
    // None of the old hashes survive.
    for (const h of finalHashes) {
      expect(oldHashes).not.toContain(h);
    }
    // And every new code matches exactly one stored hash (i.e. the
    // verify did not corrupt the regenerated batch).
    for (const c of newCodes) {
      const stripped = c.replace('-', '');
      // eslint-disable-next-line no-await-in-loop
      const matches = await Promise.all(finalHashes.map((h) => verifyPassword(stripped, h)));
      expect(matches.filter(Boolean)).toHaveLength(1);
    }
    // The verify either succeeded (race won) or failed (regen won), but
    // the second old code must NEVER work after this point.
    expect(typeof verifyOutcome.ok === 'boolean').toBe(true);
    expect((await totpService.verifyLoginCode(userId, oldBatch[1])).ok).toBe(false);
  });

  it('throttles with 429 after 10 failed attempts from the same IP (Task #129)', async () => {
    const cookie = await login();
    const ATTACKER_IP = '198.51.100.7';
    // Reset both buckets so prior tests / unique-IP traffic in this
    // file don't poison the per-account counter.
    totpRecoveryRegenerateIpLimiter.resetKey(`ip:${ATTACKER_IP}`);
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);

    // 10 failed attempts (wrong password) all return 401 — the budget
    // for this IP is exactly 10, matching authLimiter / totpVerifyLimiter.
    // We reset the per-account password-lockout state between attempts
    // so the unrelated lockout-after-5-failures defense doesn't flip
    // the response code from 401 to a different failure shape mid-loop.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // 11th attempt from the same IP is throttled — the limiter runs
    // before the route handler, so even a correct password+code combo
    // would be blocked here.
    await resetAccountLockout();
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      ATTACKER_IP,
    );
    expect(blocked.status).toBe(429);

    // Confirm the DB wasn't touched while throttled.
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(['$argon2id$placeholder']);
  });

  it('throttle bucket clears after a successful regenerate (Task #129)', async () => {
    const cookie = await login();
    const ATTACKER_IP = '198.51.100.42';
    // Start from a clean bucket so this test is independent of others.
    totpRecoveryRegenerateIpLimiter.resetKey(`ip:${ATTACKER_IP}`);
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);

    // Burn 9 of the 10 attempts on bad passwords.
    for (let i = 0; i < 9; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // One successful regenerate. The route calls resetKey() on success,
    // which fully clears both the per-IP and per-account buckets.
    await resetAccountLockout();
    const ok = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      ATTACKER_IP,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    // After the success, we should be able to make a fresh batch of
    // 10 failed attempts without ever hitting 429 — proof the bucket
    // was cleared, not just decremented by one.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // And the 11th still throttles — the limiter is still functional,
    // it just got reset by the prior success.
    await resetAccountLockout();
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      ATTACKER_IP,
    );
    expect(blocked.status).toBe(429);
  });

  it('throttles per-account even when failed attempts come from many IPs (Task #129)', async () => {
    const cookie = await login();
    // Reset the per-account bucket so prior tests don't interfere.
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);

    // 10 failed attempts spread across 10 different IPs. The per-IP
    // limiter never trips (each IP is at 1/10), but the per-account
    // limiter sees all 10 hits against the same userId.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const ip = `203.0.113.${i + 1}`;
      totpRecoveryRegenerateIpLimiter.resetKey(`ip:${ip}`);
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ip,
      );
      expect(r.status).toBe(401);
    }

    // 11th attempt from yet another fresh IP is blocked by the
    // per-account limiter even though that IP has never hit this
    // endpoint before.
    await resetAccountLockout();
    const freshIp = '203.0.113.250';
    totpRecoveryRegenerateIpLimiter.resetKey(`ip:${freshIp}`);
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      freshIp,
    );
    expect(blocked.status).toBe(429);
  });

  it('sanity: secret and password column not exposed in the response', async () => {
    const cookie = await login();
    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(200);
    const keys = Object.keys(r.body);
    expect(keys.sort()).toEqual(['recoveryCodes', 'success']);
    // Defensive: confirm the encrypted secret in the DB hasn't been
    // touched (we only rotated codes, not the secret).
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(decryptTotpSecret(after[0]!.totpSecretEncrypted!)).toBe(secretBase32);
  });
});
