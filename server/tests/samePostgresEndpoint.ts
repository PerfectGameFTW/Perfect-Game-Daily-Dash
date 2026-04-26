/**
 * Canonical-equality comparator for two Postgres connection strings
 * (Task #138, extracted in Task #141 so the helper is unit-testable
 * in isolation without dragging in the neon serverless WebSocket
 * shim that `globalTeardown.ts` pulls in at module load).
 *
 * The single job of this function is to power the safety guard in
 * `server/tests/globalTeardown.ts`: refuse to open a connection to
 * the resolved test database if it actually points at the live
 * database. Two connection strings can describe the same endpoint
 * while differing in surface form — query-parameter order, percent-
 * encoding of the username, host case, an explicit `:5432` vs the
 * Postgres default — and a naive `a === b` would let those past the
 * guard. We instead parse both URLs, lowercase what should be
 * case-insensitive, decode the username, default the port, and
 * compare the resulting tuple.
 *
 * Conservatism: if either URL is unparseable, return `true`. The
 * caller uses the result to decide "skip the audit" vs "open a
 * connection"; a false positive here costs us one silenced audit
 * cycle, while a false negative could connect to whatever the
 * malformed URL happens to be aliased to. Treating the unknown
 * case as "same" therefore strictly preserves the safety property.
 */
export function samePostgresEndpoint(a: string, b: string): boolean {
  try {
    const norm = (raw: string) => {
      const u = new URL(raw);
      return {
        protocol: u.protocol.toLowerCase(),
        host: u.hostname.toLowerCase(),
        port: u.port || '5432',
        db: u.pathname.replace(/^\//, '').replace(/\/$/, ''),
        user: decodeURIComponent(u.username),
      };
    };
    const x = norm(a);
    const y = norm(b);
    return (
      x.protocol === y.protocol &&
      x.host === y.host &&
      x.port === y.port &&
      x.db === y.db &&
      x.user === y.user
    );
  } catch {
    return true;
  }
}
