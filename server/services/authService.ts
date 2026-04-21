/**
 * Authentication Service
 * 
 * Provides authentication and user management functionality.
 */

import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { and, eq, isNull, gt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  users,
  passwordResetTokens,
  type InsertUser,
  type User,
} from '../../shared/schema';
import { sendEmail } from './emailService';

// Password reset token policy.
const RESET_TOKEN_BYTES = 32; // 256 bits of entropy in the raw token.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes.

function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// Stable advisory lock key used to serialize bootstrap attempts at the DB level.
// pg_advisory_xact_lock takes a bigint; this constant is arbitrary but fixed.
const BOOTSTRAP_ADVISORY_LOCK_KEY = BigInt('8472619341205310');

// Dummy bcrypt hash used so the "user not found" branch of loginUser still
// runs a real bcrypt.compare and takes the same wall-clock time as the
// "user exists, wrong password" branch. This prevents username enumeration
// via response-time timing.
//
// The cleartext for this hash is intentionally a long random string that is
// not a valid password and can never be matched. Generated with bcryptjs
// cost=10 (the same cost used elsewhere in this service).
const DUMMY_BCRYPT_HASH =
  '$2b$10$CwTycUXWue0Thq9StjUM0uJ8K8tQy2j8XaQjvs8R0p4U6Ww2X0o7C';

// Per-account lockout policy. After LOCKOUT_THRESHOLD consecutive failed
// password attempts, the account is locked for LOCKOUT_WINDOW_MS regardless
// of the source IP. A successful login clears the counter.
//
// Both values are env-configurable so an operator can tighten them on a
// hardened deployment (or relax them for a dev environment) without a code
// change. Defaults: 5 attempts / 15 minutes.
function parsePositiveInt(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = Number.parseInt(envValue, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const LOCKOUT_THRESHOLD = parsePositiveInt(process.env.LOGIN_LOCKOUT_THRESHOLD, 5);
const LOCKOUT_WINDOW_MS =
  parsePositiveInt(process.env.LOGIN_LOCKOUT_WINDOW_MINUTES, 15) * 60 * 1000;

export class AuthService {
  /**
   * Register a new user
   * 
   * @param username Username
   * @param password Password (plaintext, will be hashed)
   * @param role User role (default: 'user')
   * @returns Created user
   */
  async registerUser(
    username: string,
    password: string,
    role: 'user' | 'admin' = 'user',
    email?: string,
  ): Promise<User> {
    // Check if user already exists
    const existingUser = await this.getUserByUsername(username);
    if (existingUser) {
      throw new AuthError(`User with username ${username} already exists`);
    }

    // Hash password
    const hashedPassword = await hash(password, 10);

    // Create user with validated role (defaults to 'user' for any unexpected value)
    const userData: InsertUser & { email?: string } = {
      username,
      password: hashedPassword,
      role: role === 'admin' ? 'admin' : 'user',
      ...(email ? { email } : {}),
    };

    const result = await db.insert(users).values(userData).returning();
    return result[0];
  }

  /**
   * Set or clear the recovery email on an existing user. Pass an empty
   * string to clear the email (which disables password recovery for
   * that account).
   *
   * @returns The updated user, or null if no row matched.
   */
  async updateUserEmail(userId: number, email: string): Promise<User | null> {
    const normalized = email.trim();
    const valueToWrite = normalized === '' ? null : normalized;
    try {
      const result = await db
        .update(users)
        .set({ email: valueToWrite })
        .where(eq(users.id, userId))
        .returning();
      return result[0] ?? null;
    } catch (err) {
      // Postgres raises 23505 when the partial unique index on
      // LOWER(email) is violated. Surface a domain-specific error so the
      // route can return a clean 409 instead of a 500.
      if (err && typeof err === 'object' && (err as any).code === '23505') {
        throw new AuthError('Email already in use by another account');
      }
      throw err;
    }
  }

  /**
   * Bootstrap the very first admin account.
   *
   * Concurrency-safe: wraps the check-and-insert in a transaction guarded by a
   * Postgres advisory lock so two concurrent callers cannot both pass the
   * "no admins yet" check. Refuses to create a second admin if one already
   * exists.
   *
   * Intended to be invoked from a CLI/bootstrap script (out-of-band), never
   * from an unauthenticated HTTP request.
   */
  async bootstrapInitialAdmin(username: string, password: string): Promise<User> {
    const hashedPassword = await hash(password, 10);

    return await db.transaction(async (tx) => {
      // Serialize all bootstrap attempts at the DB level.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`);

      const existingAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);

      if (existingAdmins.length > 0) {
        throw new AuthError('An admin account already exists; refusing to bootstrap a second one.');
      }

      const existingByName = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (existingByName.length > 0) {
        throw new AuthError(`User with username ${username} already exists`);
      }

      const inserted = await tx
        .insert(users)
        .values({ username, password: hashedPassword, role: 'admin' })
        .returning();

      return inserted[0];
    });
  }

  /**
   * Login a user
   * 
   * @param username Username
   * @param password Password (plaintext)
   * @returns User if authentication successful, null otherwise
   */
  async loginUser(username: string, password: string): Promise<User | null> {
    // Look up the user. We always run exactly one bcrypt.compare so that
    // the response time is indistinguishable across the three failure
    // paths (no such user, locked account, wrong password). The dummy hash
    // is used whenever we don't have — or won't trust — the real hash.
    const user = await this.getUserByUsername(username);
    const now = new Date();
    const isLocked = !!(user && user.lockedUntil && user.lockedUntil > now);

    const hashToCompare =
      user && !isLocked ? user.password : DUMMY_BCRYPT_HASH;

    const passwordMatch = await compare(password, hashToCompare);

    // Unknown username: we have no row to update, but to keep timing
    // parity with the "wrong password against an existing user" path
    // (which runs one UPDATE) we issue an equivalent no-op UPDATE that
    // matches no rows. Same query shape, same round trip.
    if (!user) {
      await db.execute(
        sql`UPDATE users SET locked_until = locked_until WHERE id = -1`
      );
      return null;
    }

    if (isLocked) {
      // Locked account: do NOT increment further (would just push the
      // unlock time around). Issue a no-op UPDATE on the same row so the
      // response latency matches the wrong-password path exactly — no
      // timing oracle for "is this account currently locked?".
      await db.execute(
        sql`UPDATE users SET locked_until = locked_until WHERE id = ${user.id}`
      );
      return null;
    }

    if (!passwordMatch) {
      // Atomically increment the failure counter. If the new value crosses
      // the threshold, set lockedUntil = now + window in the same UPDATE
      // so the transition is race-free even under concurrent attempts.
      const lockUntil = new Date(Date.now() + LOCKOUT_WINDOW_MS);
      await db.execute(sql`
        UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= ${LOCKOUT_THRESHOLD}
                THEN ${lockUntil.toISOString()}::timestamptz
              ELSE locked_until
            END
        WHERE id = ${user.id}
      `);
      return null;
    }

    // Successful login: reset the failure counter and clear any prior lock.
    // (If neither was set, skip the write to avoid an unnecessary round trip.)
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    return user;
  }

  /**
   * Get user by ID
   * 
   * @param id User ID
   * @returns User if found, undefined otherwise
   */
  async getUserById(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  /**
   * Get user by username
   * 
   * @param username Username
   * @returns User if found, undefined otherwise
   */
  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  /**
   * Check if any users exist in the database
   * 
   * @returns True if users exist, false otherwise
   */
  async checkUsersExist(): Promise<boolean> {
    const count = await this.getUsersCount();
    return count > 0;
  }

  /**
   * Get the total number of users in the system
   * 
   * @returns The count of users
   */
  async getUsersCount(): Promise<number> {
    const result = await db.select().from(users);
    return result.length;
  }

  /**
   * Get all users in the system
   * 
   * @returns Array of all users
   */
  async getAllUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  /**
   * Issue a password-reset link to the account owner.
   *
   * Looks up the user by either username or email. If a matching account
   * exists AND has an email on file, a single-use token is generated, its
   * SHA-256 hash stored with a 30-minute expiry, and the raw token is
   * delivered to the account's email address. Any pre-existing unused
   * reset tokens for the same user are invalidated so only the most
   * recently issued link is valid.
   *
   * Returns void unconditionally — the caller cannot tell whether an
   * account was found or whether an email was sent. This is what
   * prevents the endpoint from being used to enumerate accounts.
   */
  async requestPasswordReset(usernameOrEmail: string, baseUrl: string): Promise<void> {
    const normalized = usernameOrEmail.trim();
    if (!normalized) return;

    // Single query that matches by username OR email (case-insensitive on
    // email since email addresses are not case-sensitive in practice).
    const found = await db
      .select()
      .from(users)
      .where(
        or(
          eq(users.username, normalized),
          sql`LOWER(${users.email}) = LOWER(${normalized})`,
        ),
      )
      .limit(1);
    const user = found[0];
    if (!user || !user.email) {
      // Either no such account or no email on file. Silently return so
      // the caller can't distinguish from the success path.
      return;
    }

    // Invalidate any prior unused tokens for this user — at most one
    // outstanding link at a time.
    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt),
        ),
      );

    const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const resetUrl = `${baseUrl.replace(/\/$/, '')}/reset?token=${rawToken}`;
    const subject = 'Reset your Perfect Game Sales Dashboard password';
    const text =
      `Hi ${user.username},\n\n` +
      `Someone requested a password reset for your account. ` +
      `If that was you, click the link below within 30 minutes to set a new password:\n\n` +
      `${resetUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password ` +
      `will not change.\n`;
    const html =
      `<p>Hi ${user.username},</p>` +
      `<p>Someone requested a password reset for your account. If that was you, ` +
      `click the link below within 30 minutes to set a new password:</p>` +
      `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
      `<p>If you didn't request this, you can safely ignore this email — your password ` +
      `will not change.</p>`;

    try {
      await sendEmail({ to: user.email, subject, text, html });
    } catch (err) {
      // Log but don't surface — we always present a generic response to
      // the caller. An ops alert from the logs is the right escalation
      // path; leaking this back to the HTTP client would be an oracle.
      console.error('[authService] Failed to send reset email:', err);
    }
  }

  /**
   * Complete a password reset using a token previously issued by
   * requestPasswordReset. The token is validated, marked used, and the
   * user's password is updated in a single transaction so a token can
   * never be redeemed twice.
   *
   * Returns true on success, false if the token is unknown, expired, or
   * already consumed.
   */
  async completePasswordReset(rawToken: string, newPassword: string): Promise<boolean> {
    if (!rawToken || typeof rawToken !== 'string') return false;
    const tokenHash = hashResetToken(rawToken);

    return await db.transaction(async (tx) => {
      const now = new Date();
      const rows = await tx
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, now),
          ),
        )
        .limit(1);

      const record = rows[0];
      if (!record) return false;

      // Mark used FIRST so a concurrent request cannot redeem the same
      // token. The WHERE clause ensures only one transaction wins.
      const consumed = await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResetTokens.id, record.id),
            isNull(passwordResetTokens.usedAt),
          ),
        )
        .returning({ id: passwordResetTokens.id });
      if (consumed.length === 0) return false;

      const hashedPassword = await hash(newPassword, 10);
      await tx
        .update(users)
        .set({
          password: hashedPassword,
          // Successful recovery: clear any outstanding lockout so the
          // user can sign in immediately with the new password.
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, record.userId));

      return true;
    });
  }

  /**
   * Delete a user by ID
   * 
   * @param id User ID to delete
   * @returns True if user was deleted, false if not found
   */
  async deleteUser(id: number): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }
}

export const authService = new AuthService();