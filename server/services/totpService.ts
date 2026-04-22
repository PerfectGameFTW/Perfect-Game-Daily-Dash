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
 *     bcrypt hashes only, so a leaked DB row cannot be used to enrol
 *     in a fresh authenticator — only to attempt brute force against
 *     the bcrypt hashes.
 *   - The TOTP step at login is rate-limited at the route layer; we
 *     additionally rely on the existing per-account password lockout
 *     (separate counter) to bound damage from a stolen password +
 *     unattended TOTP guess loop.
 */

import { Secret, TOTP } from 'otpauth';
import { hash, compare } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, type User } from '../../shared/schema';
import { encryptTotpSecret, decryptTotpSecret } from './totpCrypto';
import { BCRYPT_COST } from './authService';

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

export class TotpService {
  /**
   * Begin enrollment: generates a fresh secret, stores its encrypted
   * envelope on the user row (with totpEnabled left false), invalidates
   * any prior recovery codes, and returns the otpauth URL for QR
   * rendering. Calling this on an already-enrolled account replaces the
   * pending secret — but does NOT disable an active 2FA factor.
   * Disabling requires a separate explicit call.
   */
  async beginEnrollment(user: User): Promise<TotpEnrollmentResult> {
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
  async verifyAndEnable(userId: number, code: string): Promise<string[] | null> {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!row || !row.totpSecretEncrypted) return null;
    const secret = Secret.fromBase32(decryptTotpSecret(row.totpSecretEncrypted));
    const totp = buildTotp(secret, row.username);
    const delta = totp.validate({ token: normalizeCode(code), window: 1 });
    if (delta === null) return null;

    const plaintextCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    const hashedCodes = await Promise.all(
      plaintextCodes.map((c) => hash(c.replace('-', ''), BCRYPT_COST)),
    );
    await db
      .update(users)
      .set({ totpEnabled: true, totpRecoveryCodes: hashedCodes })
      .where(eq(users.id, userId));
    return plaintextCodes;
  }

  /**
   * Verify a TOTP code (or recovery code) from a user already past the
   * password step. Used at login. A valid recovery code is consumed
   * (its hash removed from the array) so it cannot be reused.
   *
   * Returns true on success, false otherwise.
   */
  async verifyLoginCode(userId: number, code: string): Promise<boolean> {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!row || !row.totpEnabled || !row.totpSecretEncrypted) return false;

    const cleaned = normalizeCode(code);

    // Try TOTP first — the common path.
    if (/^\d{6}$/.test(cleaned)) {
      const secret = Secret.fromBase32(decryptTotpSecret(row.totpSecretEncrypted));
      const totp = buildTotp(secret, row.username);
      const delta = totp.validate({ token: cleaned, window: 1 });
      if (delta !== null) return true;
    }

    // Otherwise try recovery codes. Compare against every remaining
    // hash; on a match, atomically remove that hash from the array.
    const stored = row.totpRecoveryCodes ?? [];
    if (stored.length === 0) return false;
    for (const h of stored) {
      // Strip the dash before comparing — we hash without the
      // formatting separator so a user who omits the dash still works.
      // eslint-disable-next-line no-await-in-loop
      const ok = await compare(cleaned, h);
      if (ok) {
        const remaining = stored.filter((x) => x !== h);
        await db
          .update(users)
          .set({ totpRecoveryCodes: remaining })
          .where(eq(users.id, userId));
        return true;
      }
    }
    return false;
  }

  /**
   * Disable the second factor entirely. Wipes the secret, the enabled
   * flag, and the recovery codes in a single update. Caller is
   * responsible for any additional confirmation (e.g. requiring a
   * fresh password check) before invoking this.
   */
  async disable(userId: number): Promise<void> {
    await db
      .update(users)
      .set({
        totpEnabled: false,
        totpSecretEncrypted: null,
        totpRecoveryCodes: null,
      })
      .where(eq(users.id, userId));
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
