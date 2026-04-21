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
// hardened `__Host-pg.sid` (i.e. anywhere outside an explicit
// development environment), browsers that signed in *before* this
// deploy will still be presenting the legacy `pg.sid` cookie. The
// session id itself is unchanged and remains valid in the
// connect-pg-simple `sessions` table — only the cookie *name* moved.
//
// Without this shim every previously-authenticated user would get
// silently logged out on deploy. Express-session reads from
// `req.headers.cookie` by name only, so we copy the legacy value
// over to the new name on the inbound request and let the
// rolling-session response set the cookie under the new hardened
// name. We also actively clear the stale legacy cookie so the
// browser stops sending two parallel session ids.
//
// This shim is a no-op once everyone has cycled onto the new name
// and can be deleted in a future pass; it costs one regex per
// request until then.
const LEGACY_SESSION_COOKIE_NAME = 'pg.sid';

export const legacyCookieCompatMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (SESSION_COOKIE_NAME === LEGACY_SESSION_COOKIE_NAME) {
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
