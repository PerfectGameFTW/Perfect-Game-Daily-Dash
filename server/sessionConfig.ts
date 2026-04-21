/**
 * Centralised session-cookie configuration.
 *
 * Why this lives in its own module:
 *   - The cookie name is referenced from both the session middleware
 *     setup (server/index.ts) and the login/logout handlers
 *     (server/routes/auth.ts) when they call res.clearCookie. Putting
 *     it in one place prevents the two sides from drifting and ending
 *     up unable to clear the cookie they just set.
 *
 * Hardening notes:
 *   - `Secure` is forced ON in every environment except an explicit
 *     `NODE_ENV === 'development'`. Anything else (production,
 *     staging, preview, test, undefined) gets `Secure: true` so the
 *     cookie is never transmitted over plain HTTP.
 *   - When `Secure` is on we use the `__Host-` cookie-name prefix.
 *     The browser will only honour it if Secure is set, the cookie
 *     has Path=/ and no Domain attribute — which prevents a
 *     compromised or malicious sibling subdomain from overwriting
 *     the session cookie. In dev (where Secure is off and the cookie
 *     therefore cannot use `__Host-`) we fall back to a plain name.
 *   - `rolling: true` (set on the session middleware) refreshes the
 *     cookie expiry on every authenticated request, so the
 *     `maxAge` below acts as an *idle* timeout. Sessions that go
 *     untouched for SESSION_IDLE_MS are dropped client-side. An
 *     additional absolute cap (SESSION_ABSOLUTE_MS) is enforced
 *     server-side so a continuously-active session cannot live
 *     forever.
 */
const isDev = process.env.NODE_ENV === 'development';

export const SESSION_COOKIE_SECURE = !isDev;
export const SESSION_COOKIE_NAME = SESSION_COOKIE_SECURE
  ? '__Host-pg.sid'
  : 'pg.sid';

// Idle timeout: any session that goes this long without a request
// is considered abandoned. Rolling sessions reset the cookie each
// request so an actively-used session keeps extending.
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Absolute upper bound regardless of activity. Forces re-auth on
// long-lived sessions to limit the blast radius of a stolen cookie.
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
