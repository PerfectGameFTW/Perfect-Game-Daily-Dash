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
    // Per-pending-session failed-verification counter (Task #102). Used
    // by /api/auth/totp/verify to surface attemptCount in the audit log
    // and is cleared on success / on pending-session expiry.
    totpFailedAttempts?: number;
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

    // Mandatory-2FA gate (Task #100). When the deployment-wide
    // require-admin-2FA toggle is on and the requester is an admin who
    // hasn't enrolled TOTP, refuse every authenticated request EXCEPT
    // the small allowlist needed for them to actually enrol or sign out
    // (otherwise we'd lock the admin out of the very screens they need
    // to fix the situation). The frontend gate in App.tsx is for UX;
    // this is the real enforcement boundary — without it an admin could
    // bypass the requirement by calling protected APIs directly with a
    // valid session cookie.
    if (user.role === 'admin' && !user.totpEnabled) {
      try {
        const setting = await pgStorage.getAppSetting(REQUIRE_ADMIN_2FA_SETTING_KEY);
        if (setting?.enabled) {
          if (!isTotpEnrollmentAllowedPath(req)) {
            return res.status(403).json({
              error: 'Two-factor authentication enrollment required',
              code: 'TOTP_ENROLLMENT_REQUIRED',
            });
          }
        }
      } catch (err) {
        // Fail-open on a transient DB hiccup looking up the setting,
        // matching createSafeUserAsync's behaviour, so a flaky storage
        // read can't lock every admin out of every page.
        logger.warn('auth.requireAuth.require_admin_2fa_lookup_failed', errorContext(err));
      }
    }

    next();
  } catch (err) {
    logger.error('auth.requireAuth.user_load_failed', errorContext(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Routes a non-enrolled admin is still allowed to hit while the
 * mandatory-2FA gate is active. Kept narrow on purpose: anything that
 * lets them either enrol (TOTP routes), confirm their identity (/me),
 * or get out (/logout). Everything else — order data, admin tools, MCP,
 * the new admin-security endpoints — is denied until they enrol.
 *
 * The check uses `req.path` (the path within the mounted router) as
 * well as `req.originalUrl` so the same allowlist works regardless of
 * whether the middleware is mounted at the app or the `/api/auth`
 * router level.
 */
function isTotpEnrollmentAllowedPath(req: Request): boolean {
  const candidates = [req.path, req.originalUrl.split('?')[0]];
  return candidates.some((p) => {
    if (!p) return false;
    // Anything under the TOTP enrollment / verification flow.
    if (p.includes('/totp/')) return true;
    if (p.endsWith('/totp')) return true;
    // Identity + sign-out endpoints.
    if (p.endsWith('/me')) return true;
    if (p.endsWith('/logout')) return true;
    return false;
  });
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
