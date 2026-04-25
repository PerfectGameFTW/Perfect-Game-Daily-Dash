/**
 * Vitest globalTeardown (Task #138).
 *
 * Runs ONCE per `vitest run` invocation, AFTER every worker has
 * exited. Its single job: audit the test database and print a loud,
 * unmistakable warning if any `public` table still holds rows.
 *
 * Why:
 *   Task #136 truncates every public table at the START of each run
 *   (globalSetup.ts), which keeps each run hermetic. The downside is
 *   that a test which forgets to clean up after itself is now silently
 *   masked — the next run's globalSetup wipes the leak before anyone
 *   can see it. This teardown turns that silent drift into a visible
 *   signal: an operator skimming the logs immediately sees which test
 *   table leaked and how many rows it left behind.
 *
 * Failure policy:
 *   This audit must NEVER fail the build. A flaky network on the
 *   audit pool, a transient timeout, an unexpected schema state — none
 *   of those should turn a green `vitest run` red. The whole audit is
 *   wrapped so any error becomes a stderr warning and the process
 *   exits 0.
 *
 * Safety:
 *   We connect to the resolved test database — never DATABASE_URL —
 *   and we duplicate the same two env-resolution guards from
 *   setup.ts / globalSetup.ts. If the resolved URL would equal
 *   DATABASE_URL (defense in depth) we refuse to connect and print a
 *   clear note. No writes are issued; this is a read-only audit.
 *
 * Output format:
 *   Clean run (no rows in any public table) → silent. The setup-time
 *   truncation already gives operators their hermetic guarantee, and
 *   adding a "no leaks" line every run would add noise without value.
 *
 *   Leaky run → a banner-bracketed block on stderr listing each
 *   non-empty table with its row count, sorted by largest leak first.
 *   The banner uses 72-character `=` rules so it stands out in CI
 *   log walls.
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

function deriveTestUrl(live: string | undefined): string | undefined {
  if (!live) return undefined;
  try {
    const u = new URL(live);
    const liveDbName = u.pathname.replace(/^\//, '');
    if (!liveDbName) return undefined;
    const testDbName = liveDbName.endsWith('_test') ? liveDbName : `${liveDbName}_test`;
    u.pathname = `/${testDbName}`;
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Compare two Postgres connection strings by canonical endpoint
 * (protocol + host + port + database + user) rather than byte
 * equality. Two strings can point at the same database while
 * differing in query-parameter order, percent-encoding, or trailing
 * slashes — string equality would miss those cases and let the
 * audit run against the live DB. We only need a conservative answer:
 * if the URLs cannot be parsed, treat them as identical (refuse to
 * connect) rather than risk a false negative.
 */
function samePostgresEndpoint(a: string, b: string): boolean {
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
    // If either URL is unparseable, refuse to audit — the safe answer
    // is "treat as same so we skip" rather than "treat as different
    // so we connect to something we can't reason about."
    return true;
  }
}

const BANNER = '='.repeat(72);

function emitWarning(lines: string[]): void {
  // Always write through stderr so the audit shows up in CI's
  // failure tail even when stdout is heavily filtered, and so a
  // CI step that pipes stdout to a file still surfaces the warning
  // on the console.
  process.stderr.write(lines.join('\n') + '\n');
}

export default async function globalTeardown(): Promise<void> {
  // Outer try/catch wraps EVERYTHING — including env resolution and
  // pool construction — so the audit can never turn a green run red.
  // The stated invariant is absolute: any failure here becomes a
  // stderr warning, never an exit-1.
  let pool: Pool | undefined;
  try {
    const liveUrl = process.env.DATABASE_URL;
    const explicit = process.env.TEST_DATABASE_URL;
    const testUrl = explicit ?? deriveTestUrl(liveUrl);

    if (!testUrl) {
      // globalSetup already aborted the run with a clear message in
      // this state; nothing to audit. Stay silent so we don't spam.
      return;
    }
    if (liveUrl && samePostgresEndpoint(testUrl, liveUrl)) {
      // Defense in depth: even though the audit is read-only, we
      // refuse to even open a connection to the live database. Use
      // canonical endpoint comparison rather than string equality so
      // an explicit TEST_DATABASE_URL that points at the live DB via
      // a re-encoded / reordered URL still trips the guard.
      emitWarning([
        '',
        BANNER,
        '[test-db-audit] SKIPPED: resolved test URL points at the same endpoint as DATABASE_URL.',
        '[test-db-audit] Refusing to issue audit queries against the live DB.',
        BANNER,
      ]);
      return;
    }

    pool = new Pool({ connectionString: testUrl, connectionTimeoutMillis: 10_000 });

    const tablesResult = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const tables = tablesResult.rows.map((r) => r.tablename);
    if (tables.length === 0) {
      // Schema not pushed yet — globalSetup already no-ops in this
      // state and the suite would have failed loudly. Nothing to do.
      return;
    }

    // Single-round-trip audit: UNION ALL of COUNT(*) per table.
    // Identifiers come from pg_tables (trusted source); we still
    // double-quote them and escape embedded `"` defensively. The
    // table name is also passed as a string literal so we escape
    // single quotes the Postgres way (double them).
    const unionParts = tables.map((t) => {
      const ident = `"public"."${t.replace(/"/g, '""')}"`;
      const literal = `'${t.replace(/'/g, "''")}'`;
      return `SELECT ${literal}::text AS tbl, COUNT(*)::bigint AS n FROM ${ident}`;
    });
    const auditQuery = unionParts.join(' UNION ALL ');
    const auditResult = await pool.query<{ tbl: string; n: string }>(auditQuery);

    const leaks = auditResult.rows
      // pg returns BIGINT as a string; BigInt() preserves precision
      // for the (theoretically possible) >2^53 case without lying.
      .map((r) => ({ tbl: r.tbl, n: BigInt(r.n) }))
      .filter((r) => r.n > BigInt(0))
      .sort((a, b) => {
        // Sort by row count descending, then by table name for stable output.
        if (a.n === b.n) return a.tbl.localeCompare(b.tbl);
        return b.n > a.n ? 1 : -1;
      });

    if (leaks.length === 0) {
      // Clean — stay silent.
      return;
    }

    const totalLeaked = leaks.reduce((acc, r) => acc + r.n, BigInt(0));
    const lines: string[] = [
      '',
      BANNER,
      `[test-db-audit] WARN: ${leaks.length} table(s) left non-empty after this vitest run`,
      `[test-db-audit] (${totalLeaked.toString()} row(s) total). The next run's`,
      "[test-db-audit] globalSetup will wipe them, but a leak indicates a test",
      '[test-db-audit] forgot to clean up after itself.',
      BANNER,
    ];
    for (const { tbl, n } of leaks) {
      lines.push(`[test-db-audit]   ${n.toString().padStart(8)} rows  ${tbl}`);
    }
    lines.push(BANNER);
    emitWarning(lines);
  } catch (err) {
    // Never fail the build from teardown — surface and move on.
    emitWarning([
      '',
      BANNER,
      `[test-db-audit] WARN: audit aborted (${(err as Error).message}).`,
      '[test-db-audit] This does NOT invalidate the test run; the suite still passed.',
      BANNER,
    ]);
  } finally {
    if (pool) {
      // Pool may have been opened before a query failed; close it.
      // Swallow errors so a teardown-time disconnect can't bubble up.
      await pool.end().catch(() => {
        /* nothing useful to do if the pool was already torn down */
      });
    }
  }
}
