import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';

import { db } from '../db';
import { users, emailVerificationTokens } from '@shared/schema';
import { authService } from '../services/authService';
import * as emailService from '../services/emailService';
import { createAuthRouter } from '../routes/auth';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

let __ipCounter = 0;
function uniqueIp(): string {
  __ipCounter += 1;
  const last = (__ipCounter % 254) + 1;
  return `192.0.2.${last}`;
}

interface TestSession {
  userId?: number;
  destroy: (cb?: (err?: Error | null) => void) => void;
}
interface RequestWithTestSession extends Request {
  session: TestSession;
}

interface JsonResp {
  status: number;
  body: any;
}

async function postJson(
  url: string,
  payload: unknown,
  opts: { asUserId?: number; ip?: string } = {},
): Promise<JsonResp> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': opts.ip ?? uniqueIp(),
  };
  if (opts.asUserId !== undefined) {
    headers['x-test-user-id'] = String(opts.asUserId);
  }
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body };
}

async function getJson(
  url: string,
  opts: { asUserId?: number; ip?: string } = {},
): Promise<JsonResp> {
  const headers: Record<string, string> = {
    'X-Forwarded-For': opts.ip ?? uniqueIp(),
  };
  if (opts.asUserId !== undefined) {
    headers['x-test-user-id'] = String(opts.asUserId);
  }
  const r = await fetch(url, { method: 'GET', headers });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body };
}

const TEST_USER = '__ev_test_user__';
const TEST_OTHER = '__ev_test_other__';
const STRONG_PASSWORD = 'Str0ng!Test-EmailVerify-9z';
const PROPOSED_EMAIL = '__ev_test_user__@example.test';
const OTHER_EMAIL = '__ev_test_other__@example.test';

describe('Recovery email verification flow (Task #98)', () => {
  let server: http.Server;
  let baseUrl: string;
  let userId: number;
  let otherUserId: number;

  beforeAll(async () => {
    // Wipe leftovers from prior runs.
    await db.delete(users).where(eq(users.username, TEST_USER));
    await db.delete(users).where(eq(users.username, TEST_OTHER));

    const u = await authService.registerUser(TEST_USER, STRONG_PASSWORD, 'user');
    userId = u.id;
    // Other user owns OTHER_EMAIL so we can exercise the uniqueness conflict.
    const o = await authService.registerUser(
      TEST_OTHER,
      STRONG_PASSWORD,
      'user',
      OTHER_EMAIL,
    );
    otherUserId = o.id;

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());

    // Test-only session shim: requireAuth only reads userId/destroy.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const asUserId = req.headers['x-test-user-id'];
      const session: TestSession = {
        destroy: (cb) => { if (cb) cb(); },
      };
      if (typeof asUserId === 'string' && asUserId !== '') {
        session.userId = Number(asUserId);
      }
      (req as RequestWithTestSession).session = session;
      next();
    });

    app.use('/api/auth', createAuthRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Cascading FK cleans up email_verification_tokens too.
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  beforeEach(async () => {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));
    // Reset the test user's email to null between tests so each scenario
    // starts with the same baseline.
    await authService.updateUserEmail(userId, '');
    vi.restoreAllMocks();
  });

  it('rejects start-verification when the caller is unauthenticated', async () => {
    const sendSpy = vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
    const r = await postJson(
      `${baseUrl}/api/auth/me/email/start-verification`,
      { email: PROPOSED_EMAIL },
      // Note: no asUserId
    );
    expect(r.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();

    const tokens = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    expect(tokens.length).toBe(0);
  });

  it('rejects an obviously malformed email and does not send anything', async () => {
    const sendSpy = vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
    const r = await postJson(
      `${baseUrl}/api/auth/me/email/start-verification`,
      { email: 'not-an-email' },
      { asUserId: userId },
    );
    expect(r.status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('issues a token, sends a verification email containing the link, and only attaches the email after confirm', async () => {
    const sendSpy = vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);

    const start = await postJson(
      `${baseUrl}/api/auth/me/email/start-verification`,
      { email: PROPOSED_EMAIL },
      { asUserId: userId },
    );
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ success: true, pendingEmail: PROPOSED_EMAIL });

    // Email was dispatched to the proposed address — never to the
    // current account email — and contains a /verify-email?token=... URL.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentMessage = sendSpy.mock.calls[0][0] as { to: string; text: string };
    expect(sentMessage.to).toBe(PROPOSED_EMAIL);
    const tokenMatch = sentMessage.text.match(/\/verify-email\?token=([a-f0-9]{64})/);
    expect(tokenMatch).not.toBeNull();
    const rawToken = tokenMatch![1];

    // The user's current email should NOT have been mutated yet —
    // confirmation is what attaches it.
    const beforeConfirm = await authService.getUserById(userId);
    expect(beforeConfirm?.email ?? null).toBeNull();

    // Token row exists, holds the proposed email, and is unused.
    const rows = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0].email).toBe(PROPOSED_EMAIL);
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].tokenHash).toBe(hashToken(rawToken));

    // Pending status reflects the outstanding token.
    const pending = await getJson(
      `${baseUrl}/api/auth/me/email/pending`,
      { asUserId: userId },
    );
    expect(pending.body).toEqual({ pending: true, pendingEmail: PROPOSED_EMAIL });

    // Confirm — no auth header, the link target is unauthenticated.
    const confirm = await postJson(
      `${baseUrl}/api/auth/me/email/confirm`,
      { token: rawToken },
    );
    expect(confirm.status).toBe(200);
    expect(confirm.body).toEqual({ success: true, email: PROPOSED_EMAIL });

    // Email is attached now.
    const afterConfirm = await authService.getUserById(userId);
    expect(afterConfirm?.email).toBe(PROPOSED_EMAIL);

    // Token marked used.
    const after = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    expect(after[0].usedAt).not.toBeNull();
  });

  it('a token cannot be redeemed twice', async () => {
    const rawToken = randomBytes(32).toString('hex');
    await db.insert(emailVerificationTokens).values({
      userId,
      email: PROPOSED_EMAIL,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const first = await postJson(
      `${baseUrl}/api/auth/me/email/confirm`,
      { token: rawToken },
    );
    expect(first.status).toBe(200);

    const second = await postJson(
      `${baseUrl}/api/auth/me/email/confirm`,
      { token: rawToken },
    );
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/invalid|expired/i);
  });

  it('rejects an expired token without attaching the email', async () => {
    const rawToken = randomBytes(32).toString('hex');
    await db.insert(emailVerificationTokens).values({
      userId,
      email: PROPOSED_EMAIL,
      tokenHash: hashToken(rawToken),
      // 10 minutes in the past
      expiresAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const r = await postJson(
      `${baseUrl}/api/auth/me/email/confirm`,
      { token: rawToken },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid|expired/i);

    const after = await authService.getUserById(userId);
    expect(after?.email ?? null).toBeNull();
  });

  it('rejects an unknown token without leaking which part is wrong', async () => {
    const r = await postJson(
      `${baseUrl}/api/auth/me/email/confirm`,
      { token: randomBytes(32).toString('hex') },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid|expired/i);
  });

  it('does not leak an enumeration oracle when the address is already on another account', async () => {
    const sendSpy = vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);

    // Try claiming the OTHER user's email (case-insensitive). The
    // server must respond with the same generic ack as a successful
    // request — no 409, no error message — so an authenticated user
    // can't probe whether arbitrary addresses are registered.
    const r = await postJson(
      `${baseUrl}/api/auth/me/email/start-verification`,
      { email: OTHER_EMAIL.toUpperCase() },
      { asUserId: userId },
    );
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    // No email is delivered (the link could never confirm anyway).
    expect(sendSpy).not.toHaveBeenCalled();
    // No token row issued.
    const tokens = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    expect(tokens.length).toBe(0);
  });

  it('starting a new verification invalidates any prior unused token for the same user', async () => {
    vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);

    // First request issues a token.
    await postJson(
      `${baseUrl}/api/auth/me/email/start-verification`,
      { email: PROPOSED_EMAIL },
      { asUserId: userId },
    );
    const firstRows = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    expect(firstRows.length).toBe(1);
    expect(firstRows[0].usedAt).toBeNull();
    const firstTokenHash = firstRows[0].tokenHash;

    // Second request (e.g. user typed wrong, retried) issues a new token
    // and invalidates the prior one — the user must always click the
    // most recent link.
    const SECOND_EMAIL = '__ev_test_user_2__@example.test';
    await postJson(
      `${baseUrl}/api/auth/me/email/start-verification`,
      { email: SECOND_EMAIL },
      { asUserId: userId },
    );
    const allRows = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    expect(allRows.length).toBe(2);
    const previous = allRows.find((r) => r.tokenHash === firstTokenHash);
    expect(previous?.usedAt).not.toBeNull();
    const current = allRows.find((r) => r.tokenHash !== firstTokenHash);
    expect(current?.usedAt).toBeNull();
    expect(current?.email).toBe(SECOND_EMAIL);
  });
});
