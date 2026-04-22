/**
 * Authentication Middleware
 *
 * Provides functionality for securing routes with user authentication.
 *
 * Every request guarded by `requireAuth` resolves the user from a
 * tiny in-process TTL cache (default 10s, see `USER_CACHE_TTL_MS` in
 * `services/authService.ts`) backed by a DB lookup on miss. The cache
 * is explicitly invalidated by every mutation path that changes a
 * user row (delete, email change, password reset, role change, totp
 * toggles), so a deleted or demoted account loses access on the very
 * next request rather than waiting up to a TTL window — there is
 * still no up-to-7-days window where a stale session keeps working
 * after the underlying user changes. `requireAdmin` reuses `req.user`
 * so even on a cache miss the round-trip happens once per request,
 * not twice.
 */

import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';
import type { User } from '../../shared/schema';
import { REQUIRE_ADMIN_2FA_SETTING_KEY } from '../../shared/schema';
import { pgStorage } from '../pgStorage';
import { logger, errorContext } from '../logger';

// Augment express-session so `req.session.userId` (and the other auth
// fields written by the login handler) are properly typed wherever a
// `Request` is used, instead of being squashed under `any`.
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: string;
    createdAt?: number;
    // Two-factor login state. After a successful password check on a
    // TOTP-enabled account, the route handler stores the candidate
    // user id (and a wall-clock issue time for expiry enforcement) on
    // the session and responds with `{ requiresTotp: true }`. The full
    // authenticated session (userId/username/role + regenerated cookie)
    // is only created after `/api/auth/totp/verify` succeeds.
    pendingTotpUserId?: number;
    pendingTotpIssuedAt?: number;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Middleware to check if a user is authenticated.
 *
 * In addition to verifying that a session exists, this loads the user
 * row from the database and attaches it to `req.user`. If the user has
 * been deleted (or otherwise can't be loaded), the stale session is
 * destroyed and the request is rejected with 401. This guarantees that
 * revoking a user takes effect on the next request, not whenever the
 * cookie happens to expire.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await authService.getUserByIdCached(userId);
    if (!user) {
      // Account no longer exists — tear down the orphaned session so
      // the client stops presenting a now-meaningless cookie.
      await new Promise<void>((resolve) => {
        req.session.destroy(() => resolve());
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = user;
    next();
  } catch (err) {
    logger.error('auth.requireAuth.user_load_failed', errorContext(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Middleware to validate admin status. Must run after `requireAuth`,
 * which is responsible for loading and attaching `req.user`. By
 * reusing that value we avoid a second DB round trip per request.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    // requireAuth wasn't applied, or it let an unauthenticated request
    // through. Fail closed.
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
}

export interface SafeUser {
  id: number;
  username: string;
  role: string;
  mustRotatePassword: boolean;
  email: string | null;
  totpEnabled: boolean;
  /**
   * True when this user is an admin, has not enrolled TOTP, and the
   * deployment-wide "require 2FA for admins" toggle is on (Task #100).
   * The frontend gates the rest of the app behind an enrollment screen
   * when this is set, similar to `mustRotatePassword`. Always false
   * for non-admins and for admins who already have TOTP enrolled.
   */
  mustEnrollTotp: boolean;
}

/**
 * Creates a user object for frontend with safe data
 * Returns null if user is falsy.
 *
 * The synchronous form intentionally does NOT compute `mustEnrollTotp`
 * — that requires a storage round-trip for the deployment-wide
 * require-admin-2FA toggle. Use `createSafeUserAsync` from the login /
 * /me / totp-verify handlers where the gate is enforced; everywhere
 * else (admin user list, email update response) the field stays
 * `false` because the value isn't user-actionable from those screens.
 */
export function createSafeUser(user: any): SafeUser | null {
  if (!user) return null;
  const rawEmail = typeof user.email === 'string' ? user.email.trim() : '';
  return {
    id: user.id,
    username: user.username,
    role: user.role || 'user',
    mustRotatePassword: Boolean(user.mustRotatePassword),
    email: rawEmail === '' ? null : rawEmail,
    totpEnabled: Boolean(user.totpEnabled),
    mustEnrollTotp: false,
  };
}

/**
 * Async variant that additionally computes `mustEnrollTotp` for admin
 * accounts by consulting the deployment-wide require-admin-2FA toggle.
 * Falls back to `false` if the storage lookup fails so a transient DB
 * hiccup never locks an admin out of every page.
 */
export async function createSafeUserAsync(user: any): Promise<SafeUser | null> {
  const safe = createSafeUser(user);
  if (!safe) return null;
  if (safe.role !== 'admin' || safe.totpEnabled) return safe;
  try {
    const setting = await pgStorage.getAppSetting(REQUIRE_ADMIN_2FA_SETTING_KEY);
    if (setting?.enabled) {
      safe.mustEnrollTotp = true;
    }
  } catch (err) {
    logger.warn('auth.require_admin_2fa.lookup_failed', errorContext(err));
  }
  return safe;
}
