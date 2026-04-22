/**
 * TOTP enrollment, verification, and recovery codes (Task #56).
 *
 * Wraps the `otpauth` library so the rest of the codebase doesn't need
 * to know which TOTP implementation is in use. All persistence happens
 * via the `users` table — `totpSecretEncrypted` holds the encrypted
 * shared secret, `totpEnabled` flips on once the first code is
 * verified, and `totpRecoveryCodes` is an array of bcrypt hashes (one
 * per remaining one-time recovery code).
 *
 * Threat model notes:
 *   - The plaintext TOTP secret never leaves this module after
 *     enrollment except via the otpauth URL handed back to the
 *     enrollment UI. The DB only ever stores the encrypted envelope.
 *   - Recovery codes are presented exactly once at enrollment. We store
 *     argon2id hashes only (legacy bcrypt hashes still verify), so a
 *     leaked DB row cannot be used to enrol in a fresh authenticator —
 *     only to attempt brute force against the password-hash work
 *     factor.
 *   - The TOTP step at login is rate-limited at the route layer; we
 *     additionally rely on the existing per-account password lockout
 *     (separate counter) to bound damage from a stolen password +
 *     unattended TOTP guess loop.
 */

import { Secret, TOTP } from 'otpauth';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, type User } from '../../shared/schema';
import { invalidateUserCache } from './authService';
import { encryptTotpSecret, decryptTotpSecret } from './totpCrypto';
import { logger } from '../logger';
// Recovery codes use the same hashing primitive as user passwords so
// the codebase has a single hash policy. The verifyPassword helper
// auto-dispatches between argon2id and any legacy bcrypt-hashed code,
// so existing recovery codes generated before the argon2 migration
// keep working until the next code is consumed.
import { hashPassword, verifyPassword } from './passwordHash';

const ISSUER = process.env.TOTP_ISSUER || 'Perfect Game Sales Dashboard';

// Number of one-time recovery codes generated at enrollment. 10 is the
// industry-standard default (matches GitHub, Google, etc.) — enough
// that an admin who loses their phone has a buffer, few enough that
// the recovery sheet fits on a single line of paper.
const RECOVERY_CODE_COUNT = 10;
// Each code is 10 base32-ish characters formatted as XXXXX-XXXXX.
// 50 bits of entropy per code — well above brute-force range when
// combined with bcrypt.
const RECOVERY_CODE_BYTES = 7; // 7 bytes -> 14 hex chars; we slice to 10

function generateRecoveryCode(): string {
  // Crockford-style alphabet: no I/O/0/1 to keep paper transcription
  // unambiguous. randomBytes -> base32-ish via lookup.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

function buildTotp(secret: Secret, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
}

export interface TotpEnrollmentResult {
  /** Base32 secret (shown to the user as a fallback to the QR code). */
  secret: string;
  /** otpauth://totp/... URL — render as a QR code for the authenticator app. */
  otpauthUrl: string;
}

/**
 * Optional caller-supplied request context for the audit trail
 * (Task #102). Routes pass this so each emitted log line carries the
 * request id and source IP that the rest of the request pipeline
 * already records — that way an operator chasing a 2FA event can pivot
 * directly from the security log to the rest of the request's lines.
 */
export interface TotpAuditContext {
  requestId?: string;
  ip?: string;
  /**
   * Per-pending-session failure counter for the login flow. Routes
   * track and increment this on each /totp/verify failure so a single
   * stolen pending cookie being used for guessing is visible from the
   * log alone.
   */
  attemptCount?: number;
  /**
   * For admin-initiated disables: the role of the actor (so the log
   * line is self-describing without joining against the users table).
   */
  actorRole?: string;
}

/**
 * Outcome of a `verifyLoginCode` call. The route layer needs to know
 * which factor was actually used so it can emit the right audit event
 * (a recovery-code consumption is operationally more interesting than
 * a normal TOTP login).
 */
export type TotpLoginResult =
  | { ok: true; factor: 'totp' | 'recovery'; recoveryCodesRemaining: number }
  | { ok: false };

export class TotpService {
  /**
   * Begin enrollment: generates a fresh secret, stores its encrypted
   * envelope on the user row (with totpEnabled left false), invalidates
   * any prior recovery codes, and returns the otpauth URL for QR
   * rendering. Calling this on an already-enrolled account replaces the
   * pending secret — but does NOT disable an active 2FA factor.
   * Disabling requires a separate explicit call.
   */
  async beginEnrollment(
    user: User,
    ctx: TotpAuditContext = {},
  ): Promise<TotpEnrollmentResult> {
    const secret = new Secret({ size: 20 }); // 160-bit, RFC 6238 recommendation
    const totp = buildTotp(secret, user.username);
    const encrypted = encryptTotpSecret(secret.base32);
    await db
      .update(users)
      .set({
        totpSecretEncrypted: encrypted,
        // Leave totpEnabled untouched: an active factor stays active
        // until the new pending secret is verified, otherwise a
        // half-completed enrollment would brick the account.
        // Recovery codes are tied to a specific secret so wipe them
        // until the new enrollment is verified.
        totpRecoveryCodes: null,
      })
      .where(eq(users.id, user.id));
    invalidateUserCache(user.id);
    logger.info('auth.totp.enrollment_started', {
      event: 'enrollment_started',
      userId: user.id,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    return {
      secret: secret.base32,
      otpauthUrl: totp.toString(),
    };
  }

  /**
   * Verify the first code from the authenticator and finalise
   * enrollment. On success: flips totpEnabled to true and generates a
   * fresh batch of one-time recovery codes (returned in plaintext for
   * the user to write down — they are NOT recoverable later).
   *
   * Returns the recovery codes on success, or null on failure (caller
   * should respond with a generic "code did not match" message).
   */
  async verifyAndEnable(
    userId: number,
    code: string,
    ctx: TotpAuditContext = {},
  ): Promise<string[] | null> {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!row || !row.totpSecretEncrypted) return null;
    const secret = Secret.fromBase32(decryptTotpSecret(row.totpSecretEncrypted));
    const totp = buildTotp(secret, row.username);
    const delta = totp.validate({ token: normalizeCode(code), window: 1 });
    if (delta === null) {
      // Distinct from a regular login failure so an operator can spot a
      // failing-enrollment loop separately (someone whose authenticator
      // app is out of sync, or someone trying to brute-force a pending
      // secret that another user just generated).
      logger.warn('auth.totp.enrollment_verify_failed', {
        event: 'enrollment_verify_failed',
        userId,
        requestId: ctx.requestId,
        ip: ctx.ip,
      });
      return null;
    }

    const plaintextCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    const hashedCodes = await Promise.all(
      plaintextCodes.map((c) => hashPassword(c.replace('-', ''))),
    );
    await db
      .update(users)
      .set({
        totpEnabled: true,
        totpRecoveryCodes: hashedCodes,
        totpLastUsedAt: new Date(),
      })
      .where(eq(users.id, userId));
    invalidateUserCache(userId);
    logger.info('auth.totp.enrollment_verified', {
      event: 'enrollment_verified',
      userId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      recoveryCodesRemaining: plaintextCodes.length,
    });
    return plaintextCodes;
  }

  /**
   * Verify a TOTP code (or recovery code) from a user already past the
   * password step. Used at login. A valid recovery code is consumed
   * (its hash removed from the array) so it cannot be reused.
   *
   * The recovery-code path uses a SELECT ... FOR UPDATE row lock so a
   * concurrent regeneration cannot be clobbered by a stale "remove this
   * hash from the array" write computed against a pre-regenerate
   * snapshot. Without the lock the read-modify-write here could
   * resurrect a freshly-rotated batch (Task #101).
   *
   * Returns true on success, false otherwise.
   */
  async verifyLoginCode(
    userId: number,
    code: string,
    ctx: TotpAuditContext = {},
  ): Promise<TotpLoginResult> {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!row || !row.totpEnabled || !row.totpSecretEncrypted) {
      logger.warn('auth.totp.login_failure', {
        event: 'totp_login_failure',
        userId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        attemptCount: ctx.attemptCount,
        reason: 'not_enrolled',
      });
      return { ok: false };
    }

    const cleaned = normalizeCode(code);
    const remainingBefore = row.totpRecoveryCodes?.length ?? 0;

    // Try TOTP first — the common path. This branch only stamps
    // totpLastUsedAt and doesn't touch the recovery code array, so a
    // simple update is safe.
    if (/^\d{6}$/.test(cleaned)) {
      const secret = Secret.fromBase32(decryptTotpSecret(row.totpSecretEncrypted));
      const totp = buildTotp(secret, row.username);
      const delta = totp.validate({ token: cleaned, window: 1 });
      if (delta !== null) {
        await db
          .update(users)
          .set({ totpLastUsedAt: new Date() })
          .where(eq(users.id, userId));
        invalidateUserCache(userId);
        logger.info('auth.totp.login_success', {
          event: 'totp_login_success',
          factor: 'totp',
          userId,
          requestId: ctx.requestId,
          ip: ctx.ip,
          recoveryCodesRemaining: remainingBefore,
        });
        return { ok: true, factor: 'totp', recoveryCodesRemaining: remainingBefore };
      }
    }

    // Otherwise try recovery codes. Take a row lock and re-read the
    // current batch inside the transaction so we never write a
    // "remaining" computed from a snapshot that has since been
    // rotated by regenerateRecoveryCodes.
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ codes: users.totpRecoveryCodes })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      const stored = locked?.codes ?? [];
      if (stored.length === 0) return { matched: false, remaining: 0 };
      for (const h of stored) {
        // Strip the dash before comparing — we hash without the
        // formatting separator so a user who omits the dash still works.
        // eslint-disable-next-line no-await-in-loop
        const ok = await verifyPassword(cleaned, h);
        if (ok) {
          const remaining = stored.filter((x) => x !== h);
          await tx
            .update(users)
            .set({ totpRecoveryCodes: remaining, totpLastUsedAt: new Date() })
            .where(eq(users.id, userId));
          invalidateUserCache(userId);
          return { matched: true, remaining: remaining.length };
        }
      }
      return { matched: false, remaining: stored.length };
    });

    if (result.matched) {
      // Recovery-code consumption is treated as a distinct, more
      // operationally interesting event than a normal TOTP login —
      // hitting this path means the user couldn't produce an
      // authenticator code, so it's worth surfacing on its own log
      // line. We also include the remaining-count so an operator can
      // tell at a glance when an account is running low on codes.
      logger.warn('auth.totp.recovery_code_used', {
        event: 'recovery_code_used',
        factor: 'recovery',
        userId,
        requestId: ctx.requestId,
        ip: ctx.ip,
        recoveryCodesRemaining: result.remaining,
      });
      return { ok: true, factor: 'recovery', recoveryCodesRemaining: result.remaining };
    }

    logger.warn('auth.totp.login_failure', {
      event: 'totp_login_failure',
      userId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      attemptCount: ctx.attemptCount,
    });
    return { ok: false };
  }

  /**
   * Regenerate the one-time recovery code batch for an already-enrolled
   * user (Task #101). The current authenticator code must validate
   * before we replace anything — that proves the caller still has the
   * second factor in hand and prevents an attacker who only has a
   * stolen session from silently rotating away the codes that the real
   * owner might be using to recover their account.
   *
   * On success, the previous hashes are wiped (so any leaked sheet of
   * old codes stops working immediately), a fresh batch is generated,
   * and the plaintext is returned ONCE for the user to write down.
   *
   * Returns the new codes on success, or null if the TOTP code didn't
   * match or the account isn't enrolled. Password re-check is the
   * caller's responsibility (mirrors how /totp/disable splits the
   * password gate from the TOTP code gate).
   */
  async regenerateRecoveryCodes(
    userId: number,
    totpCode: string,
    ctx: TotpAuditContext = {},
  ): Promise<string[] | null> {
    // Validate the TOTP code outside the transaction (cheap, doesn't
    // touch the row) so we don't hold a row lock across CPU-bound
    // crypto. Only accept a live authenticator code here — explicitly
    // NOT a recovery code, because using one of the soon-to-be-replaced
    // recovery codes to unlock regeneration would let an attacker who
    // grabbed the recovery sheet from a desk drawer rotate the codes
    // and lock out the real owner without ever seeing the authenticator
    // app.
    const cleaned = normalizeCode(totpCode);
    if (!/^\d{6}$/.test(cleaned)) return null;

    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!row || !row.totpEnabled || !row.totpSecretEncrypted) return null;
    const secret = Secret.fromBase32(decryptTotpSecret(row.totpSecretEncrypted));
    const totp = buildTotp(secret, row.username);
    const delta = totp.validate({ token: cleaned, window: 1 });
    if (delta === null) return null;

    const plaintextCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    const hashedCodes = await Promise.all(
      plaintextCodes.map((c) => hashPassword(c.replace('-', ''))),
    );

    // Lock the row before writing so an in-flight recovery-code login
    // (which read the old batch and is about to write its "consumed
    // one" filter) cannot land after this write and resurrect old
    // hashes. Postgres serializes the FOR UPDATE wait with whichever
    // transaction got the lock first, so the loser's read will see the
    // new batch and the user-visible behaviour is "the old recovery
    // code was rejected" — exactly what we want once regeneration
    // commits (Task #101).
    await db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      await tx
        .update(users)
        .set({
          totpRecoveryCodes: hashedCodes,
          // The TOTP code we just verified counts as a use, same as a
          // login flow.
          totpLastUsedAt: new Date(),
        })
        .where(eq(users.id, userId));
    });
    invalidateUserCache(userId);
    logger.info('auth.totp.recovery_codes_regenerated', {
      event: 'recovery_codes_regenerated',
      userId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      recoveryCodesRemaining: plaintextCodes.length,
    });
    return plaintextCodes;
  }

  /**
   * Disable the second factor entirely. Wipes the secret, the enabled
   * flag, and the recovery codes in a single update. Caller is
   * responsible for any additional confirmation (e.g. requiring a
   * fresh password check) before invoking this.
   */
  async disable(
    userId: number,
    ctx: TotpAuditContext = {},
  ): Promise<void> {
    await db
      .update(users)
      .set({
        totpEnabled: false,
        totpSecretEncrypted: null,
        totpRecoveryCodes: null,
      })
      .where(eq(users.id, userId));
    invalidateUserCache(userId);
    logger.warn('auth.totp.disabled', {
      event: 'totp_disabled',
      userId,
      requestId: ctx.requestId,
      ip: ctx.ip,
      // actorRole = 'self' when the user disables their own factor,
      // 'admin' for the admin-disable path. Distinguishing these in
      // the log line lets an operator filter for "someone else flipped
      // off my 2FA" without having to join against the security audit
      // table.
      actorRole: ctx.actorRole ?? 'self',
    });
  }

  /**
   * Read-only status snapshot for the enrollment UI.
   */
  async getStatus(userId: number): Promise<{
    enabled: boolean;
    pendingEnrollment: boolean;
    recoveryCodesRemaining: number;
  }> {
    const [row] = await db
      .select({
        enabled: users.totpEnabled,
        secret: users.totpSecretEncrypted,
        codes: users.totpRecoveryCodes,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) {
      return { enabled: false, pendingEnrollment: false, recoveryCodesRemaining: 0 };
    }
    return {
      enabled: row.enabled,
      pendingEnrollment: !row.enabled && !!row.secret,
      recoveryCodesRemaining: row.codes?.length ?? 0,
    };
  }
}

export const totpService = new TotpService();
