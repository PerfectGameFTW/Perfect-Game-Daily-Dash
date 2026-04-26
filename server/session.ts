import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Request, Response, NextFunction } from 'express';
import { pool } from './db';
import { logger, errorContext } from './logger';
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_SECURE,
  SESSION_IDLE_MS,
} from './sessionConfig';

const PgSession = connectPgSimple(session);

export const sessionStore = new PgSession({
  pool: pool as any,
  tableName: 'sessions',
  createTableIfMissing: true,
});

// Shared session middleware — applied to every Express request from
// server/index.ts AND run inline on WebSocket upgrades from
// server/ws.ts so /ws can authenticate the same session cookie.
export const sessionMiddleware = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  // Rolling sessions: every authenticated request resets the cookie
  // expiry, turning `cookie.maxAge` into an idle timeout. The
  // absolute upper bound is enforced by a separate middleware in
  // server/index.ts.
  rolling: true,
  cookie: {
    maxAge: SESSION_IDLE_MS,
    secure: SESSION_COOKIE_SECURE,
    sameSite: 'lax',
    httpOnly: true,
    // `__Host-` cookies must have Path=/ and no Domain attribute.
    // We never set `domain` so the cookie stays bound to the exact
    // origin that issued it.
    path: '/',
  },
  name: SESSION_COOKIE_NAME,
});

// Cookie-name compatibility shim. When SESSION_COOKIE_NAME is the
// hardened `__Host-pg.sid` (anywhere outside an explicit development
// environment), browsers that signed in *before* the cookie rename
// would still be presenting the legacy `pg.sid` cookie. The session id
// itself is unchanged in the connect-pg-simple `sessions` table — only
// the cookie *name* moved.
//
// SECURITY TRADE-OFF (the reason this shim is now opt-in and time-boxed):
// The whole point of the `__Host-` prefix is that browsers reject any
// such cookie unless it was set with Secure, Path=/, and no Domain
// attribute. That blocks a sibling subdomain or HTTP page from
// overwriting the session cookie. The legacy `pg.sid` cookie has no
// `__Host-` prefix and CAN be set by such peers; if we blindly launder
// any inbound `pg.sid` value into `__Host-pg.sid` for express-session
// to read, we re-open the very attack the prefix exists to prevent
// (login-CSRF / session injection from a controllable peer origin on
// the same eTLD+1 — relevant on custom domains that share a parent
// with attacker-controllable subdomains).
//
// Therefore the shim is now:
//   - Disabled by default. Set ENABLE_LEGACY_COOKIE_COMPAT=true to
//     enable it for a one-time migration window.
//   - Auto-expiring. LEGACY_COOKIE_DEADLINE (ISO-8601 timestamp) is
//     required when the shim is enabled; the shim becomes a no-op
//     after that instant. This forces operators to pick a cutoff
//     instead of leaving the downgrade in place forever.
//
// Once everyone has cycled onto the hardened cookie (typically a few
// idle-timeout windows after the rename deploy), unset both env vars
// and this whole module degrades to a single boolean check per
// request.
const LEGACY_SESSION_COOKIE_NAME = 'pg.sid';

const LEGACY_COMPAT_ENABLED =
  process.env.ENABLE_LEGACY_COOKIE_COMPAT === 'true';

const LEGACY_COMPAT_DEADLINE_MS: number | null = (() => {
  if (!LEGACY_COMPAT_ENABLED) return null;
  const raw = process.env.LEGACY_COOKIE_DEADLINE;
  if (!raw) {
    // Refuse to enable the downgrade without an explicit cutoff. Logged
    // once at module load so operators see it on boot. The fix is
    // documented in the message: set LEGACY_COOKIE_DEADLINE to an ISO-8601
    // timestamp. We deliberately do NOT log the variable's value (it
    // would be unset here anyway, and structured logs only carry
    // allow-listed scalars).
    logger.warn('session.legacy_cookie_compat.deadline_missing');
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    // The raw value is intentionally NOT logged: it's user-supplied env
    // input and could be any string. Operators have shell access to the
    // env they configured.
    logger.warn('session.legacy_cookie_compat.deadline_invalid');
    return null;
  }
  return parsed;
})();

function legacyShimActive(): boolean {
  if (!LEGACY_COMPAT_ENABLED) return false;
  if (LEGACY_COMPAT_DEADLINE_MS === null) return false;
  return Date.now() < LEGACY_COMPAT_DEADLINE_MS;
}

export const legacyCookieCompatMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (SESSION_COOKIE_NAME === LEGACY_SESSION_COOKIE_NAME) {
    return next();
  }
  if (!legacyShimActive()) {
    return next();
  }
  const cookieHeader = req.headers.cookie;
  if (
    cookieHeader &&
    !cookieHeader.includes(`${SESSION_COOKIE_NAME}=`) &&
    cookieHeader.includes(`${LEGACY_SESSION_COOKIE_NAME}=`)
  ) {
    const match = cookieHeader.match(/(?:^|;\s*)pg\.sid=([^;]+)/);
    if (match) {
      req.headers.cookie = `${cookieHeader}; ${SESSION_COOKIE_NAME}=${match[1]}`;
      // Tell the browser to drop the legacy cookie. We don't know
      // whether the original was Secure or not, but clearCookie
      // only needs the name + path to match for the browser to
      // expire it. `res.clearCookie` is unavailable on a raw
      // upgrade request, so we no-op when it's not a function.
      if (typeof res?.clearCookie === 'function') {
        res.clearCookie(LEGACY_SESSION_COOKIE_NAME, { path: '/' });
      }
    }
  }
  next();
};

export { SESSION_COOKIE_NAME };

/**
 * Forcibly invalidate every authenticated session belonging to a
 * given user (Task #127).
 *
 * Used by privileged admin actions that change a target's
 * authentication state — admin-disabled TOTP (#127), admin-initiated
 * password reset (#127), and admin user-deletion. The threat model:
 * an admin uses the operator console to disable 2FA on a peer admin
 * (or sends them a fresh reset link) precisely because that account
 * is suspected compromised. Without this purge, any session the
 * attacker has already established stays valid until it idles out —
 * defeating the operator's intervention. The purge closes that
 * window the moment the security state changes.
 *
 * Implementation note — direct SQL on the connect-pg-simple
 * `sessions` table:
 *   - express-session's store API only exposes `destroy(sid)`,
 *     forcing us to enumerate every session (`store.all`) and filter
 *     in JS. With even modest session counts that's both slower and
 *     race-prone (a new session can land between the listing and
 *     the destroy). One DELETE on `sess->>'userId'` happens in a
 *     single statement. Note: this DELETE is a sequential scan —
 *     connect-pg-simple's default schema only indexes `sid` (PK) and
 *     `expire`, not the JSON-extracted `userId`. That is fine at the
 *     session-table sizes we operate at (single-digit thousands of
 *     rows, called only on rare admin actions); if either of those
 *     premises ever changes, add an expression index on
 *     `(sess->>'userId')`.
 *   - We compare the JSON value as text (`$1::text`) — never as a
 *     bare integer cast — so a corrupt session row whose `userId`
 *     happens to be a non-numeric string can't blow up the whole
 *     DELETE with a cast error and leave the purge half-done.
 *   - Failures are logged but never thrown. The caller already
 *     succeeded at the security action (TOTP disabled, reset link
 *     sent); a session-store hiccup must not roll back that change.
 *     The session store is best-effort cleanup; the canonical
 *     security state is the user row + audit log, both of which the
 *     caller has already committed.
 */
export async function revokeAllSessionsForUser(
  userId: number,
  reason:
    | 'admin_disabled_totp'
    | 'admin_password_reset_initiated'
    | 'user_deleted'
    | 'self_password_changed',
): Promise<{ revoked: number }> {
  try {
    const result = await pool.query<{ count: string }>(
      `DELETE FROM sessions WHERE sess->>'userId' = $1::text`,
      [userId],
    );
    const revoked = result.rowCount ?? 0;
    // Always log — both for forensic value (an admin force-disabled
    // someone's 2FA and N live sessions were killed) AND so the
    // common no-op case (target wasn't currently signed in) is
    // observable.
    logger.warn('session.revoke_user_sessions', {
      targetUserId: userId,
      reason,
      revoked,
    });
    return { revoked };
  } catch (err) {
    logger.error('session.revoke_user_sessions_failed', {
      targetUserId: userId,
      reason,
      ...errorContext(err),
    });
    return { revoked: 0 };
  }
}
