import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Request, Response, NextFunction } from 'express';
import { pool } from './db';
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
    // once at module load so operators see it on boot.
    console.warn(
      '[session] ENABLE_LEGACY_COOKIE_COMPAT=true but ' +
        'LEGACY_COOKIE_DEADLINE is not set. The shim will stay disabled — ' +
        'set LEGACY_COOKIE_DEADLINE to an ISO-8601 timestamp (e.g. ' +
        '"2026-05-15T00:00:00Z") to enable it until that instant.',
    );
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[session] LEGACY_COOKIE_DEADLINE="${raw}" is not a valid ` +
        'ISO-8601 timestamp; the legacy cookie shim will stay disabled.',
    );
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
