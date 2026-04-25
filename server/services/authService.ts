/**
 * Authentication Service
 * 
 * Provides authentication and user management functionality.
 */

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  getDummyHash,
} from './passwordHash';

// Re-exported for any external caller that historically imported the
// bcrypt cost from here. New code should not reference this — the
// password-hash module is the single source of truth for parameters.
export { LEGACY_BCRYPT_COST as BCRYPT_COST } from './passwordHash';
import { createHash, randomBytes } from 'crypto';
import { and, count, eq, isNull, gt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  users,
  passwordResetTokens,
  emailVerificationTokens,
  type InsertUser,
  type User,
} from '../../shared/schema';
import { sendEmail } from './emailService';
import { logger, errorContext } from '../logger';

// Password reset token policy.
const RESET_TOKEN_BYTES = 32; // 256 bits of entropy in the raw token.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes.

function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// Minimal HTML escaper for values we interpolate into the recovery
// email body. The username is constrained to a safe charset by the
// `selfRegisterSchema` / `adminCreateUserSchema` regex, but the email
// HTML is sent through external mail providers that may render or
// rewrite content in ways we can't predict, and historical accounts
// created before the regex existed may still hold characters like
// `<` or `&`. Escaping at the interpolation site is the cheap belt
// to the schema's suspenders.
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// AuthError now lives in `server/errors.ts` (see Task #58). Imported (not
// re-exported) here because nothing else in the project imports it from
// authService.
import { AppError, AuthError, ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '../errors';

// Stable advisory lock key used to serialize bootstrap attempts at the DB level.
// pg_advisory_xact_lock takes a bigint; this constant is arbitrary but fixed.
const BOOTSTRAP_ADVISORY_LOCK_KEY = BigInt('8472619341205310');

// Per-process dummy hash now lives in `./passwordHash` (`getDummyHash`).
// It's an argon2id hash generated at first use with the SAME params as
// hashPassword(), so the "no such user" branch's verify cost tracks the
// real verify cost as parameters are tuned over time.

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

// ---------------------------------------------------------------------
// In-process TTL cache for user-by-id lookups (Task #83).
//
// `requireAuth` re-fetches the user row on every authenticated request
// so deleted/demoted accounts lose access immediately. That guarantee
// is correct but adds one DB round trip per hot endpoint. A short TTL
// cache keeps the revocation window tight (single-digit seconds) while
// removing the overhead from request bursts that hit the same user
// repeatedly (the common case under load).
//
// TTL is configurable via USER_CACHE_TTL_SECONDS, clamped to [1, 60]
// so a misconfiguration can't turn the cache into a long-lived stale
// store. Default 10s is the midpoint of the 5–15s window suggested by
// the task. Mutation paths (delete, email change, password change,
// role change, totp toggles) call `invalidateUserCache(id)` so a user
// who was just modified is never served from a stale entry.
// ---------------------------------------------------------------------
const USER_CACHE_TTL_MS = (() => {
  const raw = parsePositiveInt(process.env.USER_CACHE_TTL_SECONDS, 10);
  return Math.min(60, Math.max(1, raw)) * 1000;
})();
const USER_CACHE_MAX_ENTRIES = 5000;

type UserCacheEntry = { user: User; expiresAt: number };
const userCache = new Map<number, UserCacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

function cacheGet(id: number): User | undefined {
  const entry = userCache.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    userCache.delete(id);
    return undefined;
  }
  return entry.user;
}

function cacheSet(id: number, user: User): void {
  // Bounded LRU-ish eviction: when full, drop the oldest insertion (Map
  // iterates in insertion order). Re-inserting an existing key moves it
  // to the end so frequently-seen users stay hot.
  if (userCache.has(id)) userCache.delete(id);
  if (userCache.size >= USER_CACHE_MAX_ENTRIES) {
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
  userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

export function invalidateUserCache(userId: number): void {
  userCache.delete(userId);
}

// Periodic summary so hit-rate trends are visible without grepping
// per-request debug lines. Skipped when there's no traffic so a quiet
// process doesn't spam the log. unref() keeps the timer from holding
// the event loop open at shutdown.
const CACHE_SUMMARY_INTERVAL_MS = 60 * 1000;
if (process.env.NODE_ENV !== 'test') {
  const t = setInterval(() => {
    if (cacheHits === 0 && cacheMisses === 0) return;
    logger.info('user cache summary', {
      cacheHits,
      cacheMisses,
      cacheSize: userCache.size,
      ttlMs: USER_CACHE_TTL_MS,
    });
    cacheHits = 0;
    cacheMisses = 0;
  }, CACHE_SUMMARY_INTERVAL_MS);
  t.unref?.();
}

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
      throw new ConflictError(`User with username ${username} already exists`);
    }

    // Hash password (argon2id via the central abstraction)
    const hashedPassword = await hashPassword(password);

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
      invalidateUserCache(userId);
      return result[0] ?? null;
    } catch (err) {
      // Postgres raises 23505 when the partial unique index on
      // LOWER(email) is violated. Surface a domain-specific error so the
      // route can return a clean 409 instead of a 500.
      if (err && typeof err === 'object' && (err as any).code === '23505') {
        throw new ConflictError('Email already in use by another account');
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
    const hashedPassword = await hashPassword(password);

    return await db.transaction(async (tx) => {
      // Serialize all bootstrap attempts at the DB level.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`);

      const existingAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);

      if (existingAdmins.length > 0) {
        throw new ConflictError('An admin account already exists; refusing to bootstrap a second one.');
      }

      const existingByName = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (existingByName.length > 0) {
        throw new ConflictError(`User with username ${username} already exists`);
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
  /**
   * Login a user — password-only step. Returns the user row on a
   * successful password match, regardless of whether the account
   * additionally has TOTP enabled. The route layer is responsible for
   * checking `user.totpEnabled` and gating session creation behind a
   * second-factor verification step before issuing the authenticated
   * cookie.
   */
  async loginUser(username: string, password: string): Promise<User | null> {
    // Look up the user. We always run exactly one password verification
    // so that the response time is indistinguishable across the three
    // failure paths (no such user, locked account, wrong password). The
    // dummy hash is used whenever we don't have — or won't trust — the
    // real hash. verifyPassword auto-dispatches to argon2id or legacy
    // bcrypt based on the stored hash prefix.
    const user = await this.getUserByUsername(username);
    const now = new Date();
    const isLocked = !!(user && user.lockedUntil && user.lockedUntil > now);

    const hashToCompare =
      user && !isLocked ? user.password : await getDummyHash();

    const passwordMatch = await verifyPassword(password, hashToCompare);

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

    // Transparent rehash: if the stored hash is bcrypt (legacy) OR an
    // argon2id hash with weaker-than-current parameters, upgrade it
    // now that we have the plaintext in hand. The user is never asked
    // to reset — the migration is invisible from their perspective and
    // self-heals as users log in. Wrapped in try/catch so a malformed
    // hash (or rehash failure) never breaks an otherwise valid login.
    try {
      if (needsRehash(user.password)) {
        const upgraded = await hashPassword(password);
        await db
          .update(users)
          .set({ password: upgraded })
          .where(eq(users.id, user.id));
      }
    } catch (rehashErr) {
      // Ignore — login still succeeds against the existing hash. Emit
      // a warning so operators can spot a stuck rehash migration
      // without it ever blocking authentication.
      logger.warn('password transparent rehash failed', {
        userId: user.id,
        ...errorContext(rehashErr),
      });
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
   * Cached variant of `getUserById` used on hot authenticated paths
   * (see `requireAuth`). Reads go through a tiny in-process TTL cache
   * (default 10s, see USER_CACHE_TTL_MS) so a burst of requests from
   * the same user only costs one DB round trip per TTL window.
   *
   * Cache invalidation is explicit: every mutation path that changes
   * a user row calls `invalidateUserCache(id)` so a deleted/demoted
   * account loses access on the very next request, matching the
   * uncached behaviour the cache replaces.
   *
   * Per-call hit/miss is emitted at debug level; aggregate counts are
   * emitted once a minute by the summary timer above.
   */
  async getUserByIdCached(id: number): Promise<User | undefined> {
    const cached = cacheGet(id);
    if (cached) {
      cacheHits += 1;
      logger.debug('user cache lookup', { userId: id, cacheHit: true });
      return cached;
    }
    cacheMisses += 1;
    const user = await this.getUserById(id);
    logger.debug('user cache lookup', { userId: id, cacheHit: false });
    if (user) cacheSet(id, user);
    return user;
  }

  /** Drop a single user's cache entry. Safe to call with an unknown id. */
  invalidateUserCache(id: number): void {
    invalidateUserCache(id);
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
    // Use SELECT count(*) instead of pulling every user row (including
    // password hashes) through the ORM. The bootstrap check only needs
    // a "do any users exist?" boolean, so we never need the rows.
    const result = await db.select({ value: count() }).from(users);
    return Number(result[0]?.value ?? 0);
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
   * Admin-only Security overview row (Task #100). One row per user with
   * just the fields the admin Security page renders — never includes the
   * password hash, encrypted TOTP secret, or recovery code hashes.
   */
  async getAdminSecurityOverview(): Promise<
    Array<{
      id: number;
      username: string;
      role: string;
      totpEnabled: boolean;
      recoveryCodesRemaining: number;
      totpLastUsedAt: Date | null;
    }>
  > {
    // Scope to admin accounts only — this view exists so admins can see
    // which of their peers have a second factor and act on the gaps;
    // non-admin accounts have their own self-service flow and the
    // disable endpoint already refuses them, so listing them here would
    // just be misleading clutter (Task #100).
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        totpEnabled: users.totpEnabled,
        codes: users.totpRecoveryCodes,
        totpLastUsedAt: users.totpLastUsedAt,
      })
      .from(users)
      .where(eq(users.role, 'admin'));
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      totpEnabled: r.totpEnabled,
      recoveryCodesRemaining: r.codes?.length ?? 0,
      totpLastUsedAt: r.totpLastUsedAt,
    }));
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

    try {
      await this.issueAndSendResetEmail(user, baseUrl);
    } catch (err) {
      // Log but don't surface — the public endpoint always presents a
      // generic response to the caller. An ops alert from the logs is
      // the right escalation path; leaking this back to the HTTP
      // client would be an oracle. The recipient address is
      // intentionally omitted; sendEmail already records its own
      // structured audit row keyed by recipient hash (see Task #104).
      logger.error('auth.passwordReset.email_failed', {
        userId: user.id,
        ...errorContext(err),
      });
    }
  }

  /**
   * Admin-initiated password reset (Task #116).
   *
   * Looks the target up by primary key, requires a recovery email on
   * file, and issues a real reset email. Unlike the public
   * `requestPasswordReset` which is intentionally silent, this path
   * surfaces every failure (no email on file, missing user, email
   * provider failure) to the caller so the operator gets a clear toast
   * instead of a misleading generic OK. The route layer is responsible
   * for the audit-log row and for keeping this off the public
   * anti-enumeration rate limiter.
   *
   * Returns the bits the route needs to write a useful audit row
   * (target username + the email's domain — never the full address,
   * which already lives on the user row and would be redundant PII in
   * the audit table).
   */
  async adminSendPasswordReset(
    targetUserId: number,
    baseUrl: string,
  ): Promise<{ targetUsername: string; targetEmailDomain: string }> {
    const found = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    const user = found[0];
    if (!user) {
      throw new NotFoundError('User not found');
    }
    if (!user.email) {
      throw new ValidationError(
        'This account has no recovery email on file. Add one before sending a reset link.',
      );
    }
    // Surface email-provider failures as a typed external-service error
    // so the route returns a 502 with an actionable message ("the email
    // provider rejected the send") instead of a generic sanitized 500.
    // The admin caller specifically wants this signal — that's the
    // whole reason this endpoint exists separately from the public path.
    try {
      await this.issueAndSendResetEmail(user, baseUrl);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new ExternalServiceError(
        'Failed to deliver password reset email through the configured provider.',
        { code: 'PASSWORD_RESET_EMAIL_SEND_FAILED', details: { cause: err instanceof Error ? err.message : String(err) } },
      );
    }
    const at = user.email.lastIndexOf('@');
    const targetEmailDomain = at >= 0 ? user.email.slice(at + 1) : '';
    return { targetUsername: user.username, targetEmailDomain };
  }

  /**
   * Shared by the public (`requestPasswordReset`) and admin
   * (`adminSendPasswordReset`) paths. Rotates any prior unused token
   * for the user, mints a fresh single-use token, and delivers the
   * link by email. Throws on email-send failure so each caller can
   * decide whether to swallow (anti-enumeration) or surface (admin) it.
   */
  private async issueAndSendResetEmail(
    user: User,
    baseUrl: string,
  ): Promise<void> {
    if (!user.email) {
      // Defensive — both public-path callers have already gated on
      // this, but encoding the precondition here keeps the helper
      // safe for any future caller.
      throw new ValidationError('User has no email on file');
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
    // HTML body: escape every interpolated value. The reset URL is
    // safe (we built it from a 256-bit hex token + a configured
    // baseUrl), but escaping it costs nothing and removes one more
    // sharp edge if APP_BASE_URL is ever misconfigured.
    const safeUsername = escapeHtml(user.username);
    const safeResetUrl = escapeHtml(resetUrl);
    const html =
      `<p>Hi ${safeUsername},</p>` +
      `<p>Someone requested a password reset for your account. If that was you, ` +
      `click the link below within 30 minutes to set a new password:</p>` +
      `<p><a href="${safeResetUrl}">${safeResetUrl}</a></p>` +
      `<p>If you didn't request this, you can safely ignore this email — your password ` +
      `will not change.</p>`;

    await sendEmail({ to: user.email, subject, text, html });
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

    let resetUserId: number | null = null;
    const ok = await db.transaction(async (tx) => {
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

      const hashedPassword = await hashPassword(newPassword);
      await tx
        .update(users)
        .set({
          password: hashedPassword,
          // Successful recovery: clear any outstanding lockout so the
          // user can sign in immediately with the new password.
          failedLoginCount: 0,
          lockedUntil: null,
          // The user just chose a new password that satisfied the
          // strong-password policy, so the legacy-password rotation
          // requirement (Task #55) is satisfied. Always clear, even
          // if it was already false, so this stays the single
          // authoritative place that lowers the flag.
          mustRotatePassword: false,
        })
        .where(eq(users.id, record.userId));

      resetUserId = record.userId;
      return true;
    });
    // Invalidate after the transaction commits so a concurrent reader
    // can't refill the cache with the pre-commit row between the
    // invalidate and the COMMIT.
    if (ok && resetUserId !== null) invalidateUserCache(resetUserId);
    return ok;
  }

  /**
   * Self-service: an authenticated user proposes a new recovery email
   * for their own account. We generate a one-time verification token,
   * store its SHA-256 hash with a 30-minute expiry alongside the
   * proposed email (NOT yet attached to `users.email`), and deliver
   * the raw token to the proposed address. The email is only attached
   * to the account once the user clicks the link and `confirmEmailVerification`
   * succeeds — proving they control the inbox.
   *
   * Pre-checks case-insensitive uniqueness against *other* accounts.
   * On collision we silently no-op (log + return) rather than 409 to
   * avoid handing any authenticated user an email-enumeration oracle.
   * The user receives the same generic ack as a successful request;
   * if they typed an address belonging to someone else, no email is
   * ever delivered and the link cannot be confirmed. The DB-level
   * partial unique index on LOWER(email) is the ultimate enforcer.
   *
   * Any prior unused tokens for the same user are invalidated so only
   * the most recently issued link is valid — cleans up after the
   * "user typed wrong, retried" path automatically.
   */
  async requestEmailVerification(
    userId: number,
    proposedEmail: string,
    baseUrl: string,
  ): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) {
      // Caller should have verified auth, but guard anyway. Treating
      // this as a precondition failure rather than an Auth/NotFound
      // error keeps it from leaking past the route layer's generic
      // error handler in surprising ways.
      throw new AuthError('User not found');
    }

    const normalized = proposedEmail.trim();
    // Case-insensitive collision check against *other* accounts. We
    // do NOT surface this to the caller — that would create an
    // enumeration oracle (any authenticated user could probe whether
    // an arbitrary address is registered). Instead, log it and bail
    // silently; the caller still gets the generic "verification sent"
    // ack at the route layer.
    const collision = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`LOWER(${users.email}) = LOWER(${normalized})`,
          sql`${users.id} <> ${userId}`,
        ),
      )
      .limit(1);
    if (collision.length > 0) {
      logger.warn('authService.email_verification_collision_suppressed', {
        userId,
        otherUserId: collision[0]!.id,
      });
      return;
    }

    // Invalidate any prior unused tokens for this user so only the
    // most recently issued link works.
    await db
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.usedAt),
        ),
      );

    const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await db.insert(emailVerificationTokens).values({
      userId,
      email: normalized,
      tokenHash,
      expiresAt,
    });

    const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
    const subject = 'Confirm your Perfect Game Sales Dashboard recovery email';
    const text =
      `Hi ${user.username},\n\n` +
      `You (or someone signed in to your account) asked to set this address as the ` +
      `recovery email for your Perfect Game Sales Dashboard account. ` +
      `Click the link below within 30 minutes to confirm:\n\n` +
      `${verifyUrl}\n\n` +
      `If you didn't expect this, you can ignore this email — your account will ` +
      `not be changed unless the link is clicked.\n`;
    const safeUsername = escapeHtml(user.username);
    const safeVerifyUrl = escapeHtml(verifyUrl);
    const html =
      `<p>Hi ${safeUsername},</p>` +
      `<p>You (or someone signed in to your account) asked to set this address as the ` +
      `recovery email for your Perfect Game Sales Dashboard account. ` +
      `Click the link below within 30 minutes to confirm:</p>` +
      `<p><a href="${safeVerifyUrl}">${safeVerifyUrl}</a></p>` +
      `<p>If you didn't expect this, you can ignore this email — your account will ` +
      `not be changed unless the link is clicked.</p>`;

    try {
      await sendEmail({ to: normalized, subject, text, html });
    } catch (err) {
      // Same posture as the password-reset email: log and move on.
      // The route layer returns a generic ack so a transient Gmail
      // outage doesn't leak provider state to the caller.
      logger.error(
        'authService.email_verification_send_failed',
        errorContext(err),
      );
    }
  }

  /**
   * Whether the caller has an outstanding (unused, unexpired)
   * verification token. The route uses this to decide whether to
   * render "check your inbox" vs. the empty form on the recovery-
   * email screen after a refresh.
   */
  async hasPendingEmailVerification(userId: number): Promise<{
    pending: boolean;
    pendingEmail: string | null;
  }> {
    const rows = await db
      .select({
        email: emailVerificationTokens.email,
        expiresAt: emailVerificationTokens.expiresAt,
      })
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const row = rows[0];
    return {
      pending: Boolean(row),
      pendingEmail: row?.email ?? null,
    };
  }

  /**
   * Confirm a recovery-email verification token. Atomically (in one
   * DB transaction):
   *   1. Validates the token (exists, unused, unexpired).
   *   2. Marks it used so it can never be redeemed twice.
   *   3. Sets users.email to the address the token was issued for.
   *
   * Returns the confirmed email on success. Returns null when the
   * token is unknown / expired / already used. Throws ConflictError
   * if another account claimed the same email between the request
   * and the confirm — in which case the transaction rolls back so
   * the token remains *unused* and the user can retry with a fresh
   * address (no token-burn defect).
   */
  async confirmEmailVerification(
    rawToken: string,
  ): Promise<{ email: string; userId: number } | null> {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = hashResetToken(rawToken);
    const now = new Date();

    let result: { email: string; userId: number } | null = null;
    try {
      await db.transaction(async (tx) => {
        // Atomically claim the token. The WHERE clause guarantees only
        // one concurrent caller wins, and the RETURNING gives us the
        // userId + proposed email in the same round trip.
        const claimed = await tx
          .update(emailVerificationTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(emailVerificationTokens.tokenHash, tokenHash),
              isNull(emailVerificationTokens.usedAt),
              gt(emailVerificationTokens.expiresAt, now),
            ),
          )
          .returning({
            userId: emailVerificationTokens.userId,
            email: emailVerificationTokens.email,
          });
        const record = claimed[0];
        if (!record) return;

        const updated = await tx
          .update(users)
          .set({ email: record.email })
          .where(eq(users.id, record.userId))
          .returning({ id: users.id });
        if (updated.length === 0) {
          // User row vanished between request and confirm. Roll back
          // so the token isn't silently burned — a re-issued token
          // against a still-extant user can succeed cleanly.
          throw new Error('email_verification_user_missing');
        }

        result = { email: record.email, userId: record.userId };
      });
    } catch (err) {
      // Postgres 23505 = unique-violation on uniq_users_email_lower.
      // Another account claimed the same address between request and
      // confirm. The transaction rolled back so the token is still
      // unused; surface a 409 so the route returns a clean error.
      if (err && typeof err === 'object' && (err as any).code === '23505') {
        throw new ConflictError('Email already in use by another account');
      }
      // Internal sentinel for the missing-user rollback above.
      if (err instanceof Error && err.message === 'email_verification_user_missing') {
        return null;
      }
      throw err;
    }

    if (result) invalidateUserCache((result as { userId: number }).userId);
    return result;
  }

  /**
   * Delete a user by ID
   * 
   * @param id User ID to delete
   * @returns True if user was deleted, false if not found
   */
  async deleteUser(id: number): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    invalidateUserCache(id);
    return result.length > 0;
  }
}

export const authService = new AuthService();