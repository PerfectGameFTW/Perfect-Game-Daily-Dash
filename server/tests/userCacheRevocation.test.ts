/**
 * User-cache revocation invariants (Task #112).
 *
 * Task #83 added a short TTL cache for user lookups in `requireAuth`.
 * Every mutation path that changes a user row is supposed to call
 * `invalidateUserCache(id)` so the *very next* authenticated request
 * sees the new state — no up-to-TTL window of stale-credential access.
 *
 * If a future refactor ever forgets to invalidate one of these paths,
 * the regression would be silent (the only symptom would be a window
 * of stale auth that someone happens to notice). These tests pin the
 * behaviour: for each mutation we
 *   1. seed the cache by reading the user once,
 *   2. mutate the row through the service layer,
 *   3. assert the next read reflects the change immediately — without
 *      waiting for the TTL to expire.
 *
 * Coverage: deleteUser, updateUserEmail, completePasswordReset, TOTP
 * enroll (verifyAndEnable), TOTP disable, confirmEmailVerification,
 * TOTP beginEnrollment, TOTP regenerateRecoveryCodes (Task #152). The
 * deleteUser path is also exercised end-to-end through `requireAuth`
 * so the session-destroy + 401 behaviour is locked in too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { createHash, randomBytes } from 'crypto';

import { db } from '../db';
import {
  users,
  passwordResetTokens,
  emailVerificationTokens,
} from '@shared/schema';
import { authService, invalidateUserCache } from '../services/authService';
import { totpService } from '../services/totpService';
import { encryptTotpSecret } from '../services/totpCrypto';
import { verifyPassword } from '../services/passwordHash';
import { requireAuth } from '../middleware/auth';

const STRONG_PASSWORD = 'Cache!Revoke-Test-Pwd-7q';
const NEW_STRONG_PASSWORD = 'N3w!Revoke-Test-Pwd-Wx';

// Username prefix scoped to this file so the global teardown audit
// doesn't blame other suites if one of these tests crashes before its
// cleanup runs.
const PREFIX = '__cache_revoke__';

function uniqueUsername(label: string): string {
  // Suffix with a short random tag so re-running the same test in a
  // worker that wasn't fully torn down can't hit a stale row from an
  // earlier attempt.
  return `${PREFIX}${label}_${randomBytes(3).toString('hex')}`;
}

interface FakeSession {
  userId?: number;
  destroy: (cb: () => void) => void;
  destroyed: boolean;
}

function makeReq(userId: number | undefined): Request {
  const session: FakeSession = {
    userId,
    destroyed: false,
    destroy(cb: () => void) {
      this.destroyed = true;
      this.userId = undefined;
      cb();
    },
  };
  return {
    session,
    path: '/',
    originalUrl: '/',
  } as unknown as Request;
}

interface FakeResponse {
  statusCode: number | null;
  body: any;
  status(code: number): FakeResponse;
  json(payload: any): FakeResponse;
}

function makeRes(): FakeResponse {
  const r: FakeResponse = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return r;
}

interface AuthOutcome {
  /** When set, requireAuth called next() and attached this user. */
  user?: { id: number; email: string | null; totpEnabled: boolean };
  /** When set, requireAuth short-circuited with this status. */
  rejectedStatus?: number;
  rejectedBody?: any;
  sessionDestroyed: boolean;
}

async function runRequireAuth(userId: number | undefined): Promise<AuthOutcome> {
  const req = makeReq(userId);
  const res = makeRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  await requireAuth(req, res as unknown as Response, next);
  const sessionDestroyed = (req.session as unknown as FakeSession).destroyed;
  if (nextCalled && (req as any).user) {
    const u = (req as any).user;
    return {
      user: { id: u.id, email: u.email, totpEnabled: u.totpEnabled },
      sessionDestroyed,
    };
  }
  return {
    rejectedStatus: res.statusCode ?? undefined,
    rejectedBody: res.body,
    sessionDestroyed,
  };
}

describe('User cache invalidation on revocation paths (Task #112)', () => {
  const createdUserIds: number[] = [];

  async function createUser(label: string, opts: { email?: string } = {}) {
    const username = uniqueUsername(label);
    // Wipe any leftover row from a prior aborted run.
    await db.delete(users).where(eq(users.username, username));
    const u = await authService.registerUser(
      username,
      STRONG_PASSWORD,
      'user',
      opts.email,
    );
    createdUserIds.push(u.id);
    return u;
  }

  beforeAll(async () => {
    // Defensive no-op so the suite doesn't open with a write that
    // could leave half-state if the connection is sick on startup.
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
      invalidateUserCache(id);
    }
  });

  it('deleteUser: requireAuth sees the deletion immediately, destroys the session, and returns 401', async () => {
    const u = await createUser('delete');

    // Seed the cache by running requireAuth once. Sanity-check it
    // returned the live row before we mutate.
    const before = await runRequireAuth(u.id);
    expect(before.user?.id).toBe(u.id);
    expect(before.sessionDestroyed).toBe(false);

    // Real assertion: deletion through authService MUST invalidate
    // the cache, so the very next requireAuth call sees that the row
    // is gone and tears down the session.
    const deleted = await authService.deleteUser(u.id);
    expect(deleted).toBe(true);

    const after = await runRequireAuth(u.id);
    expect(after.user).toBeUndefined();
    expect(after.rejectedStatus).toBe(401);
    expect(after.sessionDestroyed).toBe(true);

    // And the cached lookup directly must also see undefined — i.e.
    // we're not just relying on requireAuth's "user not found" branch
    // catching a stale cached row, the cache itself was invalidated.
    const cached = await authService.getUserByIdCached(u.id);
    expect(cached).toBeUndefined();
  });

  it('updateUserEmail: cache returns the new email on the very next read', async () => {
    const u = await createUser('email', { email: `${PREFIX}old@example.test` });

    // Warm the cache.
    const before = await authService.getUserByIdCached(u.id);
    expect(before?.email).toBe(`${PREFIX}old@example.test`);

    const newEmail = `${PREFIX}new@example.test`;
    const updated = await authService.updateUserEmail(u.id, newEmail);
    expect(updated?.email).toBe(newEmail);

    // No sleep, no TTL wait — must be the new value immediately.
    const after = await authService.getUserByIdCached(u.id);
    expect(after?.email).toBe(newEmail);

    // requireAuth should also see the new value.
    const auth = await runRequireAuth(u.id);
    expect(auth.user?.email).toBe(newEmail);
  });

  it('updateUserEmail to empty: cache returns null email on the very next read', async () => {
    const u = await createUser('email_clear', {
      email: `${PREFIX}clear@example.test`,
    });

    await authService.getUserByIdCached(u.id); // seed

    await authService.updateUserEmail(u.id, '');
    const after = await authService.getUserByIdCached(u.id);
    expect(after?.email).toBeNull();
  });

  it('completePasswordReset: cache returns the new password hash on the very next read', async () => {
    const u = await createUser('pwreset', {
      email: `${PREFIX}pwreset@example.test`,
    });

    // Seed the cache and capture the initial hash so the post-mutation
    // read can be proven distinct (argon2id is randomized, so any
    // re-hash differs — what we actually verify is that the new hash
    // accepts the new password).
    const seeded = await authService.getUserByIdCached(u.id);
    expect(seeded).toBeDefined();
    const originalHash = seeded!.password;
    expect(await verifyPassword(STRONG_PASSWORD, originalHash)).toBe(true);

    // Issue a reset token directly so the test doesn't depend on
    // email delivery.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await db.insert(passwordResetTokens).values({
      userId: u.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const ok = await authService.completePasswordReset(rawToken, NEW_STRONG_PASSWORD);
    expect(ok).toBe(true);

    // Next cached read must reflect the rewritten password row, not
    // the seeded copy.
    const after = await authService.getUserByIdCached(u.id);
    expect(after).toBeDefined();
    expect(after!.password).not.toBe(originalHash);
    expect(await verifyPassword(NEW_STRONG_PASSWORD, after!.password)).toBe(true);
  });

  it('TOTP verifyAndEnable: cache returns totpEnabled=true on the very next read', async () => {
    const u = await createUser('totp_enroll');

    // Inject a known secret directly so the test owns the TOTP key
    // (decrypting the auto-generated one would couple the test to
    // the crypto module's private surface). beginEnrollment also
    // invalidates the cache, so we don't call it — we set the row
    // directly and then seed the cache against that row.
    const knownSecret = new Secret({ size: 20 });
    await db
      .update(users)
      .set({ totpSecretEncrypted: encryptTotpSecret(knownSecret.base32) })
      .where(eq(users.id, u.id));
    invalidateUserCache(u.id);

    const seeded = await authService.getUserByIdCached(u.id);
    expect(seeded?.totpEnabled).toBe(false);

    const totp = new TOTP({
      issuer: 'Perfect Game Sales Dashboard',
      label: u.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: knownSecret,
    });
    const code = totp.generate();
    const recoveryCodes = await totpService.verifyAndEnable(u.id, code);
    expect(recoveryCodes).not.toBeNull();
    expect(recoveryCodes!.length).toBeGreaterThan(0);

    // Next cached read must show the flipped flag — without the
    // invalidation in verifyAndEnable, the seeded `totpEnabled=false`
    // would still be served here.
    const after = await authService.getUserByIdCached(u.id);
    expect(after?.totpEnabled).toBe(true);

    const auth = await runRequireAuth(u.id);
    expect(auth.user?.totpEnabled).toBe(true);
  });

  it('TOTP disable: cache returns totpEnabled=false on the very next read', async () => {
    const u = await createUser('totp_disable');

    // Pre-enable TOTP directly so this test isolates the disable
    // path. We don't go through beginEnrollment + verifyAndEnable
    // because their invalidations would mask whether the *disable*
    // call invalidates correctly.
    const knownSecret = new Secret({ size: 20 });
    await db
      .update(users)
      .set({
        totpSecretEncrypted: encryptTotpSecret(knownSecret.base32),
        totpEnabled: true,
        totpRecoveryCodes: [],
      })
      .where(eq(users.id, u.id));
    invalidateUserCache(u.id);

    const seeded = await authService.getUserByIdCached(u.id);
    expect(seeded?.totpEnabled).toBe(true);

    await totpService.disable(u.id);

    const after = await authService.getUserByIdCached(u.id);
    expect(after?.totpEnabled).toBe(false);

    const auth = await runRequireAuth(u.id);
    expect(auth.user?.totpEnabled).toBe(false);
  });

  // --- Task #152: lock in cache invalidation for the remaining
  // account-change paths. Same shape as the suites above:
  //   1. seed the cache with the pre-mutation row,
  //   2. drive the real service method,
  //   3. assert the very next cached read reflects the change with no
  //      TTL wait.
  // If a future refactor drops one of these `invalidateUserCache`
  // calls the corresponding test below will start showing the seeded
  // (pre-mutation) row instead of the new value and fail loudly.

  it('confirmEmailVerification: cache returns the verified email on the very next read', async () => {
    const oldEmail = `${PREFIX}confirm_old@example.test`;
    const newEmail = `${PREFIX}confirm_new@example.test`;
    const u = await createUser('confirm_email', { email: oldEmail });

    // Seed the cache against the user's *current* recovery email so
    // we can prove the next read picks up the verified address rather
    // than the seeded copy.
    const seeded = await authService.getUserByIdCached(u.id);
    expect(seeded?.email).toBe(oldEmail);

    // Issue a verification token directly against the proposed new
    // address so the test doesn't depend on the email-send pipeline.
    // Token hashing here mirrors what authService does internally
    // (sha256 of the raw token), which is the same scheme the
    // password-reset test uses above — so any change to the hashing
    // contract will surface in both suites.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await db.insert(emailVerificationTokens).values({
      userId: u.id,
      email: newEmail,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await authService.confirmEmailVerification(rawToken);
    expect(result).toEqual({ email: newEmail, userId: u.id });

    // Without the invalidation in confirmEmailVerification, the
    // seeded `oldEmail` row would still be served here for up to one
    // cache TTL.
    const after = await authService.getUserByIdCached(u.id);
    expect(after?.email).toBe(newEmail);

    // requireAuth should also see the verified address immediately.
    const auth = await runRequireAuth(u.id);
    expect(auth.user?.email).toBe(newEmail);
  });

  it('TOTP beginEnrollment: cache returns the wiped recovery codes on the very next read', async () => {
    const u = await createUser('totp_begin');

    // Pre-state the row as if the user had already completed
    // enrollment with one batch of recovery codes. We do this
    // directly rather than going through verifyAndEnable so the
    // seeded cache contains a known non-null `totpRecoveryCodes`
    // array that beginEnrollment must visibly clear.
    const seededSecret = new Secret({ size: 20 });
    const seededRecoveryCodes = ['SEED-CODE-AAAA', 'SEED-CODE-BBBB'];
    await db
      .update(users)
      .set({
        totpSecretEncrypted: encryptTotpSecret(seededSecret.base32),
        totpEnabled: true,
        totpRecoveryCodes: seededRecoveryCodes,
      })
      .where(eq(users.id, u.id));
    invalidateUserCache(u.id);

    // Re-read so beginEnrollment receives a fresh User object that
    // matches the row we just wrote (its signature takes a User).
    const seededRow = await authService.getUserByIdCached(u.id);
    expect(seededRow?.totpRecoveryCodes).toEqual(seededRecoveryCodes);

    await totpService.beginEnrollment(seededRow!);

    // Without the invalidation in beginEnrollment, this read would
    // still see the seeded `seededRecoveryCodes` array.
    const after = await authService.getUserByIdCached(u.id);
    expect(after?.totpRecoveryCodes).toBeNull();
    // Sanity: the row's encrypted secret should also have rotated to
    // the new pending one. We don't decrypt-and-compare base32 here
    // (that would couple the test to the crypto module's private
    // surface), it's enough that the ciphertext changed.
    expect(after?.totpSecretEncrypted).not.toBe(
      encryptTotpSecret(seededSecret.base32),
    );
  });

  it('TOTP regenerateRecoveryCodes: cache returns the new code batch on the very next read', async () => {
    const u = await createUser('totp_regen');

    // Pre-enable TOTP with a known secret + a known recovery-code
    // batch so the seeded cache reads a deterministic array. We
    // bypass beginEnrollment + verifyAndEnable for the same reason
    // the TOTP enroll/disable suites above do: their own
    // invalidations would mask whether the *regenerate* call clears
    // the cache.
    const knownSecret = new Secret({ size: 20 });
    const seededRecoveryCodes = ['REGEN-SEED-1111', 'REGEN-SEED-2222'];
    await db
      .update(users)
      .set({
        totpSecretEncrypted: encryptTotpSecret(knownSecret.base32),
        totpEnabled: true,
        totpRecoveryCodes: seededRecoveryCodes,
      })
      .where(eq(users.id, u.id));
    invalidateUserCache(u.id);

    const seeded = await authService.getUserByIdCached(u.id);
    expect(seeded?.totpRecoveryCodes).toEqual(seededRecoveryCodes);

    // Drive a live authenticator code so regenerateRecoveryCodes
    // accepts the request (it explicitly refuses recovery codes
    // here, see the comment above its body).
    const totp = new TOTP({
      issuer: 'Perfect Game Sales Dashboard',
      label: u.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: knownSecret,
    });
    const code = totp.generate();
    const newCodes = await totpService.regenerateRecoveryCodes(u.id, code);
    expect(newCodes).not.toBeNull();
    expect(newCodes!.length).toBeGreaterThan(0);

    // Without the invalidation in regenerateRecoveryCodes the next
    // read would still serve the seeded array. The new array on the
    // row stores hashes (not the plaintext codes returned to the
    // caller), so we assert the hashes differ from the seeded
    // plaintext rather than try to round-trip the new plaintext.
    const after = await authService.getUserByIdCached(u.id);
    expect(after?.totpRecoveryCodes).not.toBeNull();
    expect(after?.totpRecoveryCodes).not.toEqual(seededRecoveryCodes);
    expect(after?.totpRecoveryCodes!.length).toBe(newCodes!.length);
  });
});
