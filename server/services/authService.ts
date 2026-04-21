/**
 * Authentication Service
 * 
 * Provides authentication and user management functionality.
 */

import { compare, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, type InsertUser, type User } from '../../shared/schema';

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
  async registerUser(username: string, password: string, role: 'user' | 'admin' = 'user'): Promise<User> {
    // Check if user already exists
    const existingUser = await this.getUserByUsername(username);
    if (existingUser) {
      throw new AuthError(`User with username ${username} already exists`);
    }

    // Hash password
    const hashedPassword = await hash(password, 10);

    // Create user with validated role (defaults to 'user' for any unexpected value)
    const userData: InsertUser = {
      username,
      password: hashedPassword,
      role: role === 'admin' ? 'admin' : 'user',
    };

    const result = await db.insert(users).values(userData).returning();
    return result[0];
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
   * Reset a user's password by username.
   *
   * @param username Username
   * @param newPassword New plaintext password (will be hashed)
   * @returns True if password was reset, false if user not found
   */
  async resetPassword(username: string, newPassword: string): Promise<boolean> {
    const user = await this.getUserByUsername(username);
    if (!user) {
      return false;
    }
    const hashedPassword = await hash(newPassword, 10);
    await db.update(users).set({ password: hashedPassword }).where(eq(users.id, user.id));
    return true;
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