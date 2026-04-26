/**
 * Task #171 — Force users out of all devices on self-service password change.
 *
 * Two scenarios:
 *   1. POST /api/auth/complete-reset (token-based reset, unauthenticated):
 *      a previously-valid cookie from another device stops working immediately.
 *
 *   2. POST /api/auth/me/password (authenticated account-page change):
 *      other devices are immediately signed out while the device that
 *      initiated the change stays signed in.
 *
 * Both use the real connect-pg-simple store (same `sessions` table as
 * production) so the DELETE-based revocation in `revokeAllSessionsForUser`
 * is visible to the session middleware within the same test run.
 *
 * NOTE: GET /api/auth/me returns { user } or null (always HTTP 200) to
 * support page-load auth checks. "Signed out" is detected by a null body;
 * routes guarded by requireAuth (like POST /me/password) return 401.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { randomBytes, createHash } from 'crypto';
import { inArray } from 'drizzle-orm';

import { db, pool } from '../db';
import { users, passwordResetTokens } from '@shared/schema';
import { authService } from '../services/authService';
import { sessionStore } from '../session';
import { createAuthRouter } from '../routes/auth';

const USERNAME_A = '__t171_user_a__';
const USERNAME_B = '__t171_user_b__';
const STRONG_PWD = 'T171TestPwd!Reset-z9';
const NEW_STRONG_PWD = 'T171NewPwd!Changed-x8';

let app: express.Express;
let server: http.Server;
let baseUrl: string;
let userAId: number;
let userBId: number;

// Counter-based RFC5737 TEST-NET-2 address so each request gets its own
// rate-limiter bucket and tests never trip the per-IP caps.
let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  return `198.51.100.${(__ipCounter % 254) + 1}`;
}

interface JsonResp {
  status: number;
  body: unknown;
  cookie: string | null;
}

async function jsonReq(
  url: string,
  method: 'GET' | 'POST',
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
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch { /* not JSON */ }
  return { status: r.status, body, cookie: r.headers.get('set-cookie') };
}

async function login(username: string): Promise<string> {
  const r = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
    username,
    password: STRONG_PWD,
  });
  expect(r.status).toBe(200);
  const body = r.body as Record<string, unknown>;
  expect(body.user).toBeDefined();
  return r.cookie!.split(';')[0];
}

/** Returns true when GET /me indicates the session is authenticated. */
async function isSignedIn(cookie: string): Promise<boolean> {
  const r = await jsonReq(`${baseUrl}/api/auth/me`, 'GET', undefined, cookie);
  return r.status === 200 && r.body !== null;
}

/** Restore the test user's password to STRONG_PWD between test cases. */
async function resetPasswordToDefault(userId: number): Promise<void> {
  await authService.changeOwnPassword(userId, STRONG_PWD);
}

beforeAll(async () => {
  // Clean up any leftover rows from previous failed runs.
  await db.delete(users).where(inArray(users.username, [USERNAME_A, USERNAME_B]));

  const a = await authService.registerUser(USERNAME_A, STRONG_PWD, 'admin');
  userAId = a.id;
  const b = await authService.registerUser(USERNAME_B, STRONG_PWD, 'admin');
  userBId = b.id;

  app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(
    session({
      // Use the real production-configured PG store so the DELETE in
      // revokeAllSessionsForUser hits the same `sessions` table that the
      // session middleware reads. An in-memory store would hide the
      // revocation from the middleware entirely.
      store: sessionStore,
      name: 't171.sid',
      secret: 'test-secret-t171-only',
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
  await pool.query(
    `DELETE FROM sessions WHERE sess->>'userId' IN ($1, $2)`,
    [String(userAId), String(userBId)],
  );
  await db
    .delete(users)
    .where(inArray(users.id, [userAId, userBId]));
});

describe('Task #171 — self-service password change signs all other devices out', () => {
  describe('POST /api/auth/complete-reset', () => {
    it('a previously-valid session cookie stops working immediately after the owner resets their password', async () => {
      // "Device A" logs in and gets a live, authenticated cookie.
      const cookieA = await login(USERNAME_A);

      // Confirm cookie A is valid before the reset.
      expect(await isSignedIn(cookieA)).toBe(true);

      try {
        // Seed a valid reset token directly (bypasses email delivery).
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        await db.insert(passwordResetTokens).values({
          userId: userAId,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        // "Device B" (or the owner from a different browser) completes
        // the reset. No cookie needed — the endpoint is unauthenticated.
        const reset = await jsonReq(`${baseUrl}/api/auth/complete-reset`, 'POST', {
          token: rawToken,
          newPassword: NEW_STRONG_PWD,
        });
        expect(reset.status).toBe(200);
        expect((reset.body as Record<string, unknown>).success).toBe(true);

        // Cookie A must now be rejected — the session was revoked.
        // GET /me returns null (200) when not signed in, so we use the
        // helper that treats null as "signed out".
        expect(await isSignedIn(cookieA)).toBe(false);
      } finally {
        // Always restore the password so subsequent test cases can login.
        await resetPasswordToDefault(userAId);
      }
    });

    it('does not invalidate sessions belonging to a DIFFERENT user', async () => {
      // User B's session must survive a reset triggered for user A.
      const cookieB = await login(USERNAME_B);

      try {
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        await db.insert(passwordResetTokens).values({
          userId: userAId,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        const reset = await jsonReq(`${baseUrl}/api/auth/complete-reset`, 'POST', {
          token: rawToken,
          newPassword: NEW_STRONG_PWD,
        });
        expect(reset.status).toBe(200);

        // User B's session must still be alive.
        expect(await isSignedIn(cookieB)).toBe(true);
      } finally {
        await resetPasswordToDefault(userAId);
      }
    });
  });

  describe('POST /api/auth/me/password', () => {
    it('a cookie held by another device stops working immediately after the owner changes their password', async () => {
      // "Device A" (attacker) obtained a valid session cookie somehow.
      const cookieA = await login(USERNAME_A);
      // "Device B" (the legitimate owner) is also logged in.
      const cookieB = await login(USERNAME_A);

      // Confirm both cookies are valid before the change.
      expect(await isSignedIn(cookieA)).toBe(true);
      expect(await isSignedIn(cookieB)).toBe(true);

      try {
        // Device B changes the password.
        const change = await jsonReq(
          `${baseUrl}/api/auth/me/password`,
          'POST',
          { currentPassword: STRONG_PWD, newPassword: NEW_STRONG_PWD },
          cookieB,
        );
        expect(change.status).toBe(200);
        expect((change.body as Record<string, unknown>).success).toBe(true);

        // Device A's session must now be revoked.
        expect(await isSignedIn(cookieA)).toBe(false);
      } finally {
        await resetPasswordToDefault(userAId);
      }
    });

    it('the device that initiated the change stays signed in', async () => {
      const cookie = await login(USERNAME_A);

      try {
        const change = await jsonReq(
          `${baseUrl}/api/auth/me/password`,
          'POST',
          { currentPassword: STRONG_PWD, newPassword: NEW_STRONG_PWD },
          cookie,
        );
        expect(change.status).toBe(200);

        // The same cookie should still be accepted — the session was
        // re-persisted after the revocation so this device stays signed in.
        expect(await isSignedIn(cookie)).toBe(true);
      } finally {
        await resetPasswordToDefault(userAId);
      }
    });

    it('rejects when the current password is wrong (no session revocation occurs)', async () => {
      const cookie = await login(USERNAME_A);

      const change = await jsonReq(
        `${baseUrl}/api/auth/me/password`,
        'POST',
        { currentPassword: 'definitely-wrong-password', newPassword: NEW_STRONG_PWD },
        cookie,
      );
      expect(change.status).toBe(401);

      // Session must still be valid — the failure path must not revoke.
      expect(await isSignedIn(cookie)).toBe(true);
    });

    it('rejects without an authenticated session (401)', async () => {
      const r = await jsonReq(
        `${baseUrl}/api/auth/me/password`,
        'POST',
        { currentPassword: STRONG_PWD, newPassword: NEW_STRONG_PWD },
      );
      expect(r.status).toBe(401);
    });

    it('rejects a weak new password (400)', async () => {
      const cookie = await login(USERNAME_A);

      const change = await jsonReq(
        `${baseUrl}/api/auth/me/password`,
        'POST',
        { currentPassword: STRONG_PWD, newPassword: 'weak' },
        cookie,
      );
      expect(change.status).toBe(400);
    });
  });
});
