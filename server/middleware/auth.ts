/**
 * Authentication Middleware
 *
 * Provides functionality for securing routes with user authentication.
 *
 * Every request guarded by `requireAuth` re-fetches the user from the
 * database and attaches it to `req.user`. This means a deleted or
 * demoted account loses access on the very next request — there is no
 * up-to-7-days window where a stale session keeps working after the
 * underlying user changes. `requireAdmin` reuses `req.user` so the
 * round-trip happens once per request, not twice.
 */

import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';
import type { User } from '../../shared/schema';
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
    const user = await authService.getUserById(userId);
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

/**
 * Creates a user object for frontend with safe data
 * Returns null if user is falsy
 */
export function createSafeUser(
  user: any,
): {
  id: number;
  username: string;
  role: string;
  mustRotatePassword: boolean;
  email: string | null;
} | null {
  if (!user) return null;

  // Return only safe user data (exclude password). `mustRotatePassword`
  // is exposed so the client can gate the rest of the app behind a
  // forced password-change screen for accounts whose password predates
  // the strong-password policy (see Task #55). Defaults to false for
  // any legacy code path that hands us a user shape missing the field.
  // `email` is the recovery email shown in the admin user-management
  // table so operators can see at a glance which accounts are enrolled
  // in the password-reset flow (see Task #59). Normalized to null when
  // the column is missing or empty so the client can render a single
  // empty-state consistently.
  const rawEmail = typeof user.email === 'string' ? user.email.trim() : '';
  return {
    id: user.id,
    username: user.username,
    role: user.role || 'user', // Default to 'user' if role is missing
    mustRotatePassword: Boolean(user.mustRotatePassword),
    email: rawEmail === '' ? null : rawEmail,
  };
}
