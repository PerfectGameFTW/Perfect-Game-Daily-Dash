/**
 * DB-persistence of TOTP audit events (Task #131).
 *
 * Companion to `totpAuditLog.test.ts` — that file pins the structured
 * stdout side; this one pins the security_audit_log row that the same
 * call sites must now also write so SOC review has a single queryable
 * surface for every 2FA event (not just admin-disable).
 *
 * Two contracts under test:
 *   1. Each in-scope TotpService event writes exactly one row to
 *      security_audit_log with the expected action / actor / target /
 *      ip / metadata shape.
 *   2. The write is fire-and-forget: a DB failure on the audit insert
 *      MUST NOT propagate to the caller or block the auth flow.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { eq, inArray, and, asc } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { db } from '../db';
import { users, securityAuditLog } from '@shared/schema';
import { authService } from '../services/authService';
import { totpService } from '../services/totpService';
import { pgStorage } from '../pgStorage';

const USERNAME = '__totp_audit_persist_user__';
const PWD = 'AuditPersist!Test-Pwd-31';

let __ip = 0;
function uniqueIp(): string {
  __ip += 1;
  return `198.51.101.${(__ip % 254) + 1}`;
}

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

/**
 * persistAuditRow is fire-and-forget — the caller doesn't await the
 * recordSecurityAudit insert. Tests need a deterministic way to wait
 * for those background writes to settle before they query the table.
 *
 * Strategy: wrap pgStorage.recordSecurityAudit in a spy that pushes
 * each invocation's promise into a pending list; tests await
 * `Promise.allSettled(pending)` before asserting against the DB.
 */
let pendingAuditWrites: Promise<unknown>[] = [];
let recordAuditSpy: ReturnType<typeof vi.spyOn> | null = null;

function trackAuditWrites(): void {
  pendingAuditWrites = [];
  const original = pgStorage.recordSecurityAudit.bind(pgStorage);
  recordAuditSpy = vi.spyOn(pgStorage, 'recordSecurityAudit');
  recordAuditSpy.mockImplementation((entry: any) => {
    const p = original(entry);
    pendingAuditWrites.push(p.catch(() => undefined));
    return p;
  });
}

async function flushAuditWrites(): Promise<void> {
  await Promise.allSettled(pendingAuditWrites);
  pendingAuditWrites = [];
}

describe('TOTP audit-log DB persistence (Task #131)', () => {
  let userId: number;

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, USERNAME));
    const u = await authService.registerUser(USERNAME, PWD, 'admin');
    userId = u.id;
  });

  afterAll(async () => {
    // Order matters: securityAuditLog rows reference the user via
    // actorUserId/targetUserId (no FK, but still our own data) — clear
    // them before the user row so a future test seeding the same id
    // can't pick up phantom audit rows.
    await db
      .delete(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(async () => {
    // Reset to a known-disabled state so each test starts clean and
    // can re-enroll deterministically.
    await db
      .update(users)
      .set({
        totpEnabled: false,
        totpSecretEncrypted: null,
        totpRecoveryCodes: null,
        totpLastUsedAt: null,
      })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
    // Clear prior audit rows for this user so each test asserts on the
    // rows it actually produced rather than accumulating noise.
    await db
      .delete(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, userId));
    trackAuditWrites();
  });

  afterEach(async () => {
    await flushAuditWrites();
    recordAuditSpy?.mockRestore();
    recordAuditSpy = null;
  });

  async function rowsFor(action: string) {
    return db
      .select()
      .from(securityAuditLog)
      .where(
        and(
          eq(securityAuditLog.actorUserId, userId),
          eq(securityAuditLog.action, action),
        ),
      )
      .orderBy(asc(securityAuditLog.id));
  }

  it('persists totp.enrollment_started on beginEnrollment', async () => {
    const ip = uniqueIp();
    const requestId = 'req-enroll-start-1';
    const user = (await authService.getUserById(userId))!;
    await totpService.beginEnrollment(user, { requestId, ip });
    await flushAuditWrites();

    const rows = await rowsFor('totp.enrollment_started');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].targetUserId).toBe(userId);
    expect(rows[0].actorIp).toBe(ip);
    expect(rows[0].metadata).toMatchObject({
      event: 'enrollment_started',
      requestId,
    });
  });

  it('persists totp.enrollment_verify_failed on a bad first code', async () => {
    const user = (await authService.getUserById(userId))!;
    await totpService.beginEnrollment(user, { ip: uniqueIp() });

    const ip = uniqueIp();
    const requestId = 'req-enroll-fail-1';
    const result = await totpService.verifyAndEnable(
      userId,
      '000000', // wrong code
      { requestId, ip },
    );
    await flushAuditWrites();

    expect(result).toBeNull();
    const rows = await rowsFor('totp.enrollment_verify_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].targetUserId).toBe(userId);
    expect(rows[0].actorIp).toBe(ip);
    expect(rows[0].metadata).toMatchObject({
      event: 'enrollment_verify_failed',
      requestId,
    });
  });

  it('persists totp.enrollment_verified with recovery-code count on success', async () => {
    const user = (await authService.getUserById(userId))!;
    const enrollment = await totpService.beginEnrollment(user, { ip: uniqueIp() });

    const ip = uniqueIp();
    const requestId = 'req-enroll-ok-1';
    const codes = await totpService.verifyAndEnable(
      userId,
      currentCode(enrollment.secret, USERNAME),
      { requestId, ip },
    );
    await flushAuditWrites();

    expect(codes).not.toBeNull();
    const rows = await rowsFor('totp.enrollment_verified');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].targetUserId).toBe(userId);
    expect(rows[0].actorIp).toBe(ip);
    expect(rows[0].metadata).toMatchObject({
      event: 'enrollment_verified',
      requestId,
      recoveryCodesRemaining: codes!.length,
    });
  });

  it('persists totp.login_success with factor=totp on a good login code', async () => {
    const user = (await authService.getUserById(userId))!;
    const enrollment = await totpService.beginEnrollment(user, { ip: uniqueIp() });
    await totpService.verifyAndEnable(
      userId,
      currentCode(enrollment.secret, USERNAME),
      { ip: uniqueIp() },
    );
    await flushAuditWrites();
    // Clear enrollment-phase rows so we assert specifically on the
    // login row we're about to produce.
    await db
      .delete(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, userId));

    const ip = uniqueIp();
    const requestId = 'req-login-ok-1';
    const result = await totpService.verifyLoginCode(
      userId,
      currentCode(enrollment.secret, USERNAME),
      { requestId, ip },
    );
    await flushAuditWrites();

    expect(result.ok).toBe(true);
    const rows = await rowsFor('totp.login_success');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].targetUserId).toBe(userId);
    expect(rows[0].actorIp).toBe(ip);
    expect(rows[0].metadata).toMatchObject({
      event: 'totp_login_success',
      factor: 'totp',
      requestId,
    });
  });

  it('persists totp.login_failure with attemptCount on a bad login code', async () => {
    const user = (await authService.getUserById(userId))!;
    const enrollment = await totpService.beginEnrollment(user, { ip: uniqueIp() });
    await totpService.verifyAndEnable(
      userId,
      currentCode(enrollment.secret, USERNAME),
      { ip: uniqueIp() },
    );
    await flushAuditWrites();
    await db
      .delete(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, userId));

    const ip = uniqueIp();
    const requestId = 'req-login-bad-1';
    const result = await totpService.verifyLoginCode(userId, '000000', {
      requestId,
      ip,
      attemptCount: 3,
    });
    await flushAuditWrites();

    expect(result.ok).toBe(false);
    const rows = await rowsFor('totp.login_failure');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].targetUserId).toBe(userId);
    expect(rows[0].actorIp).toBe(ip);
    expect(rows[0].metadata).toMatchObject({
      event: 'totp_login_failure',
      requestId,
      attemptCount: 3,
    });
  });

  it('persists totp.login_failure with reason=not_enrolled when 2FA is off', async () => {
    // User exists but never enrolled — verifyLoginCode hits the early
    // not_enrolled branch, and that branch must also persist its row.
    const ip = uniqueIp();
    const requestId = 'req-login-noenroll-1';
    const result = await totpService.verifyLoginCode(userId, '123456', {
      requestId,
      ip,
      attemptCount: 1,
    });
    await flushAuditWrites();

    expect(result.ok).toBe(false);
    const rows = await rowsFor('totp.login_failure');
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      event: 'totp_login_failure',
      reason: 'not_enrolled',
      requestId,
      attemptCount: 1,
    });
  });

  it('persists totp.recovery_code_used with the post-consumption remaining count', async () => {
    const user = (await authService.getUserById(userId))!;
    const enrollment = await totpService.beginEnrollment(user, { ip: uniqueIp() });
    const recoveryCodes = await totpService.verifyAndEnable(
      userId,
      currentCode(enrollment.secret, USERNAME),
      { ip: uniqueIp() },
    );
    await flushAuditWrites();
    await db
      .delete(securityAuditLog)
      .where(eq(securityAuditLog.actorUserId, userId));

    const ip = uniqueIp();
    const requestId = 'req-recovery-1';
    const result = await totpService.verifyLoginCode(
      userId,
      recoveryCodes![0],
      { requestId, ip },
    );
    await flushAuditWrites();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.factor).toBe('recovery');

    const rows = await rowsFor('totp.recovery_code_used');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].targetUserId).toBe(userId);
    expect(rows[0].actorIp).toBe(ip);
    expect(rows[0].metadata).toMatchObject({
      event: 'recovery_code_used',
      factor: 'recovery',
      requestId,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    });
  });

  it('does not block the auth flow when the audit-row insert fails', async () => {
    // Force the persistence layer to reject. The TOTP operation itself
    // must still succeed — that is the whole point of fire-and-forget.
    // Without this guarantee, a transient DB blip on the audit table
    // would lock users out of 2FA, which is the opposite of the goal.
    recordAuditSpy?.mockRestore();
    const failSpy = vi
      .spyOn(pgStorage, 'recordSecurityAudit')
      .mockRejectedValue(new Error('synthetic audit DB failure'));

    const user = (await authService.getUserById(userId))!;
    const enrollment = await totpService.beginEnrollment(user, {
      ip: uniqueIp(),
      requestId: 'req-fail-1',
    });
    expect(enrollment.secret).toBeTruthy();
    expect(enrollment.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

    // Verify the insert was actually attempted (and rejected) — otherwise
    // we're not really exercising the failure path.
    expect(failSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'totp.enrollment_started' }),
    );
    // Let the rejected promise settle so unhandled-rejection warnings
    // don't leak into other tests.
    await new Promise((r) => setImmediate(r));
    failSpy.mockRestore();
  });
});
