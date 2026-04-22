import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash, randomBytes } from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';

import { db } from '../db';
import { users, passwordResetTokens } from '@shared/schema';
import { authService } from '../services/authService';
import * as emailService from '../services/emailService';
import { createAuthRouter } from '../routes/auth';

function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Deterministic counter-based IP allocator. Each call returns a fresh
// RFC5737 TEST-NET-1 address so each request gets its own
// express-rate-limit bucket and tests never trip the per-IP caps. Using
// a counter (rather than Math.random()) keeps test runs reproducible
// and rules out the astronomically unlikely collision.
let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  // 192.0.2.0/24 has 254 usable addresses; far more than any single
  // test needs, but wrap defensively in case the suite grows.
  const last = (__ipCounter % 254) + 1;
  return `192.0.2.${last}`;
}

interface JsonResp {
  status: number;
  body: any;
  elapsedMs: number;
}

async function postJson(
  url: string,
  payload: unknown,
  ip = uniqueIp(),
): Promise<JsonResp> {
  const start = process.hrtime.bigint();
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body, elapsedMs };
}

/**
 * Bounded poll. Avoids brittle fixed sleeps after setImmediate-deferred
 * work — we wait until the predicate is true or the deadline expires.
 */
async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { timeoutMs = 2000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

const TEST_USERNAME_WITH_EMAIL = '__pr_test_with_email__';
const TEST_USERNAME_NO_EMAIL = '__pr_test_no_email__';
const TEST_EMAIL = '__pr_test_with_email__@example.test';
const NONEXISTENT_USERNAME = '__pr_test_does_not_exist__';
const STRONG_PASSWORD = 'Str0ng!Reset-Test-Pwd-9z';
const NEW_STRONG_PASSWORD = 'N3w!Reset-Test-Pwd-Ab';

describe('Password reset flow', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let userWithEmailId: number;
  let userNoEmailId: number;

  beforeAll(async () => {
    // Wipe any leftover rows from a previous failed run.
    await db.delete(users).where(eq(users.username, TEST_USERNAME_WITH_EMAIL));
    await db.delete(users).where(eq(users.username, TEST_USERNAME_NO_EMAIL));
    await db.delete(users).where(eq(users.username, NONEXISTENT_USERNAME));

    const u1 = await authService.registerUser(
      TEST_USERNAME_WITH_EMAIL,
      STRONG_PASSWORD,
      'user',
      TEST_EMAIL,
    );
    userWithEmailId = u1.id;

    const u2 = await authService.registerUser(
      TEST_USERNAME_NO_EMAIL,
      STRONG_PASSWORD,
      'user',
    );
    userNoEmailId = u2.id;

    app = express();
    // express-rate-limit reads req.ip; trusting the loopback proxy hop
    // lets each test inject its own IP via X-Forwarded-For so the
    // limiters don't share buckets across tests. Using 'loopback' (as
    // opposed to `true`) avoids the express-rate-limit permissive-proxy
    // warning while still trusting headers we send from 127.0.0.1.
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use('/api/auth', createAuthRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Cascading FK on password_reset_tokens cleans up token rows too.
    await db.delete(users).where(eq(users.id, userWithEmailId));
    await db.delete(users).where(eq(users.id, userNoEmailId));
  });

  beforeEach(async () => {
    // Drop any token rows left from earlier tests so each scenario starts
    // from a clean slate.
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userWithEmailId));
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userNoEmailId));
    vi.restoreAllMocks();
  });

  it('returns the same status, body, and approximate latency for nonexistent vs existing-with-email vs existing-without-email accounts', async () => {
    // Warm up — first call pays one-time JIT/connection costs that would
    // otherwise dwarf the parity comparison.
    await postJson(`${baseUrl}/api/auth/request-reset`, { usernameOrEmail: '__warmup__' });

    const nonexistent = await postJson(`${baseUrl}/api/auth/request-reset`, { usernameOrEmail: NONEXISTENT_USERNAME });
    const withEmail = await postJson(`${baseUrl}/api/auth/request-reset`, { usernameOrEmail: TEST_USERNAME_WITH_EMAIL });
    const withoutEmail = await postJson(`${baseUrl}/api/auth/request-reset`, { usernameOrEmail: TEST_USERNAME_NO_EMAIL });

    // Identical status code.
    expect(nonexistent.status).toBe(200);
    expect(withEmail.status).toBe(200);
    expect(withoutEmail.status).toBe(200);

    // Identical response body — the generic anti-enumeration message.
    // Pin the exact wording so an inadvertent change to the user-facing
    // copy (which would also subtly change the response shape an
    // attacker observes) is caught here.
    const EXPECTED_MESSAGE =
      'If an account matching that username or email exists and has a recovery email on file, ' +
      'a password reset link has been sent. Check your inbox (and spam folder) within a few minutes.';
    expect(nonexistent.body).toEqual({ message: EXPECTED_MESSAGE });
    expect(withEmail.body).toEqual({ message: EXPECTED_MESSAGE });
    expect(withoutEmail.body).toEqual({ message: EXPECTED_MESSAGE });

    // Approximate latency parity. Real DB / network jitter on a shared CI
    // box can easily produce single-request swings of ~100ms even when
    // the server-side work is constant, so the bound is loose — the test
    // is guarding against a regression where the existing-user branch
    // becomes synchronously much slower (which would re-introduce the
    // timing oracle). The route uses setImmediate to defer work off the
    // response path; this assertion catches a regression that removes
    // that.
    const all = [nonexistent.elapsedMs, withEmail.elapsedMs, withoutEmail.elapsedMs];
    const max = Math.max(...all);
    const min = Math.min(...all);
    expect(max - min).toBeLessThan(250);

    // The setImmediate work runs after the response. Poll instead of
    // sleeping to avoid timing flakes — wait until the with-email branch
    // has issued its token, then snapshot the side-effect rows.
    const withEmailTokens = await waitFor(
      () => db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, userWithEmailId)),
      (rows) => rows.length > 0,
    );
    const withoutEmailTokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, userNoEmailId));

    expect(withEmailTokens.length).toBe(1);
    expect(withoutEmailTokens.length).toBe(0);
  });

  it('redeems a token at most once even under concurrent POST /api/auth/complete-reset calls', async () => {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    await db.insert(passwordResetTokens).values({
      userId: userWithEmailId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Fire two HTTP completion attempts at the same time. The
    // transaction-guarded UPDATE in completePasswordReset must serialize
    // them so exactly one wins. Use distinct IPs so authLimiter buckets
    // don't muddy the result.
    const url = `${baseUrl}/api/auth/complete-reset`;
    const [a, b] = await Promise.all([
      postJson(url, { token: rawToken, newPassword: NEW_STRONG_PASSWORD }, uniqueIp()),
      postJson(url, { token: rawToken, newPassword: NEW_STRONG_PASSWORD + '!' }, uniqueIp()),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 400 ? a : b;
    expect(winner.body).toMatchObject({ success: true });
    // Loser should get a sanitized invalid-or-expired-link error, not a
    // 500 or any token-state leak.
    expect(typeof loser.body.error).toBe('string');
    expect(loser.body.error).toMatch(/invalid|expired/i);

    // Token row should be marked consumed exactly once.
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash));
    expect(rows.length).toBe(1);
    expect(rows[0].usedAt).not.toBeNull();
  });

  it('rejects a POST /api/auth/complete-reset whose token has already expired', async () => {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    await db.insert(passwordResetTokens).values({
      userId: userWithEmailId,
      tokenHash,
      // 10 minutes in the past.
      expiresAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const r = await postJson(
      `${baseUrl}/api/auth/complete-reset`,
      { token: rawToken, newPassword: NEW_STRONG_PASSWORD },
    );
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error).toMatch(/invalid|expired/i);

    // The expired row must NOT have been marked consumed — refusal
    // happens before the UPDATE.
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash));
    expect(rows.length).toBe(1);
    expect(rows[0].usedAt).toBeNull();
  });

  it('refuses to construct a reset link from the Host header in production when APP_BASE_URL is unset (no email sent, no token issued)', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevBaseUrl = process.env.APP_BASE_URL;
    process.env.NODE_ENV = 'production';
    delete process.env.APP_BASE_URL;

    // Spy on both layers an attacker could observe a side-channel from:
    // the service entry point AND the underlying email transport. The
    // route-level guard should short-circuit before either is reached.
    const requestSpy = vi.spyOn(authService, 'requestPasswordReset');
    const sendSpy = vi.spyOn(emailService, 'sendEmail');

    try {
      const r = await postJson(
        `${baseUrl}/api/auth/request-reset`,
        { usernameOrEmail: TEST_USERNAME_WITH_EMAIL },
      );
      // Always 200 + generic message — never an enumeration oracle even
      // when the server is misconfigured.
      expect(r.status).toBe(200);
      expect(typeof r.body.message).toBe('string');

      // Give the (would-be) setImmediate work a chance to run before we
      // assert it didn't happen. A short bounded wait is enough — the
      // event loop drains setImmediate before any timers.
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setTimeout(res, 50));

      expect(requestSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();

      // No token row should have been created either.
      const tokens = await db
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.userId, userWithEmailId),
            isNull(passwordResetTokens.usedAt),
          ),
        );
      expect(tokens.length).toBe(0);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevBaseUrl === undefined) {
        delete process.env.APP_BASE_URL;
      } else {
        process.env.APP_BASE_URL = prevBaseUrl;
      }
    }
  });

  // -------------------------------------------------------------------------
  // Brute-force / rate-limit regression coverage (Task #105)
  // -------------------------------------------------------------------------
  // Every other test in this file deliberately rotates the source IP per
  // request so the rate limiters never trip and we can isolate the
  // correctness/timing/single-use behavior. These tests do the OPPOSITE:
  // they pin a single attacker IP and walk the limiter past its budget,
  // so a future refactor that detaches `passwordResetRequestLimiter` or
  // `authLimiter` from these endpoints (or silently relaxes their caps)
  // fails loudly here.
  //
  // express-rate-limit's default in-memory store is module-level state
  // shared across the whole test process. To avoid being polluted by
  // (or polluting) other tests we use IPs in the 203.0.113.0/24
  // (TEST-NET-3) block that no other test in the suite uses; the other
  // tests live in 192.0.2.0/24 (TEST-NET-1) and 198.51.100.0/24
  // (TEST-NET-2). The two new tests also use distinct IPs from each
  // other so /request-reset's bucket can't bleed into /complete-reset's
  // (they share neither limiter nor IP).
  describe('brute-force caps', () => {
    it('caps /api/auth/request-reset at 3 requests per hour per IP and the 4th returns 429 with a generic body (no enumeration)', async () => {
      const attackerIp = '203.0.113.10';
      const url = `${baseUrl}/api/auth/request-reset`;

      // First three requests inside the hour-long window must succeed
      // with the standard generic 200 response, regardless of whether
      // the username exists.
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await postJson(url, { usernameOrEmail: TEST_USERNAME_WITH_EMAIL }, attackerIp);
        expect(r.status).toBe(200);
      }

      // Fourth request from the same IP — even targeting an account
      // we KNOW exists — must be cut off by the limiter.
      const blockedExisting = await postJson(
        url,
        { usernameOrEmail: TEST_USERNAME_WITH_EMAIL },
        attackerIp,
      );
      expect(blockedExisting.status).toBe(429);

      // And targeting a user we know does NOT exist must give the
      // exact same 429 — the limiter must not become an enumeration
      // oracle. We compare body shape (not just status) because an
      // attacker who can distinguish "rate-limited because the user
      // exists and we triggered an email" from "rate-limited because
      // the IP is over budget" recovers most of the signal the
      // generic-200 response was designed to hide.
      const blockedNonexistent = await postJson(
        url,
        { usernameOrEmail: NONEXISTENT_USERNAME },
        attackerIp,
      );
      expect(blockedNonexistent.status).toBe(429);
      expect(blockedNonexistent.body).toEqual(blockedExisting.body);
      // The rate-limit body itself must not echo the username back or
      // otherwise reveal account state.
      const serialized = JSON.stringify(blockedExisting.body).toLowerCase();
      expect(serialized).not.toContain(TEST_USERNAME_WITH_EMAIL.toLowerCase());
      expect(serialized).not.toContain(TEST_EMAIL.toLowerCase());
    });

    it('caps /api/auth/complete-reset at 10 attempts per 15 minutes per IP and the 11th returns 429', async () => {
      const attackerIp = '203.0.113.20';
      const url = `${baseUrl}/api/auth/complete-reset`;

      // Ten bogus-token attempts should all be processed (and rejected
      // as invalid tokens with 400) before the limiter intervenes. We
      // use a fresh random "looks like a real token" string per attempt
      // to make sure we're exercising the route's token-lookup path
      // rather than short-circuiting on schema validation.
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await postJson(
          url,
          { token: randomBytes(32).toString('hex'), newPassword: NEW_STRONG_PASSWORD },
          attackerIp,
        );
        // 400 = invalid/expired token; the precise message is asserted
        // elsewhere. The point here is that the limiter has NOT yet
        // engaged.
        expect(r.status).toBe(400);
      }

      // Eleventh attempt from the same IP must be cut off.
      const blocked = await postJson(
        url,
        { token: randomBytes(32).toString('hex'), newPassword: NEW_STRONG_PASSWORD },
        attackerIp,
      );
      expect(blocked.status).toBe(429);
      // The limiter response is JSON with an error field — pin the
      // shape so a future refactor that swaps it for a plaintext body
      // (which some frontends silently mis-handle) is caught.
      expect(typeof blocked.body.error).toBe('string');
    });
  });
});
