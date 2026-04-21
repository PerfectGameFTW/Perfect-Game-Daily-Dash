/**
 * One-off verification script for MCP run_read_query hardening (Task #44).
 *
 * Run with: `tsx scripts/verify-mcp-hardening.ts`
 *
 * Checks:
 *   1. The parser/keyword allow-list rejects every documented bypass
 *      (quoted "users", comment-split keywords, system schema refs,
 *      multi-statement, CTE-wrapped sensitive tables, metadata-only
 *      queries with no business-table reference).
 *   2. A representative set of legitimate business queries is accepted.
 *   3. The restricted Postgres role `mcp_read_only` is provisioned and
 *      Postgres itself denies SELECT on `users`, `sessions`, `pg_authid`
 *      with SQLSTATE 42501.
 *   4. A normal business query succeeds under the restricted role.
 *
 * Exits with non-zero status on any failure so this script can be wired
 * into CI/release verification.
 */

import "dotenv/config";
import { ensureMcpReadRole, pool } from "../server/db";
import { validateReadQueryTables } from "../server/mcp";

const blocked: string[] = [
  "SELECT * FROM pg_shadow",
  "SELECT * FROM pg_user",
  "SELECT * FROM pg_stat_activity",
  "SELECT * FROM pg_settings",
  "SELECT * FROM pg_catalog.pg_user",
  "SELECT * FROM information_schema.tables",
  'SELECT * FROM "users"',
  'SELECT * FROM "public"."users"',
  "SELECT /* a */ * FR/* b */OM users",
  "SELECT * FROM orders; SELECT * FROM users",
  "WITH x AS (SELECT * FROM pg_authid) SELECT * FROM x",
  "SELECT current_setting('jwt.claims.user_id')",
  "SELECT current_user",
  "SELECT version()",
  "SELECT 1",
  "SELECT * FROM other_schema.orders",
  "SELECT * FROM mystery_table",
];

const allowed: string[] = [
  "SELECT * FROM orders WHERE id = 1",
  "SELECT count(*) FROM orders",
  "SELECT o.id, li.name FROM orders o JOIN order_line_items li ON li.order_id = o.id LIMIT 10",
  "WITH t AS (SELECT * FROM transactions) SELECT * FROM t",
  "SELECT date_trunc('day', created_at AT TIME ZONE 'America/New_York') d, sum(total_money) FROM orders GROUP BY 1",
  "SELECT * FROM public.orders",
  "(SELECT square_id FROM orders) UNION (SELECT square_id FROM refunds)",
];

let failures = 0;
function record(ok: boolean, msg: string) {
  console.log(`${ok ? "OK" : "FAIL"}  ${msg}`);
  if (!ok) failures += 1;
}

async function main() {
  for (const q of blocked) {
    let rejected = false;
    let why = "";
    try {
      validateReadQueryTables(q);
    } catch (e) {
      rejected = true;
      why = (e as Error).message;
    }
    record(rejected, `parser blocks: ${q}${rejected ? `  (${why})` : ""}`);
  }
  for (const q of allowed) {
    let accepted = true;
    let why = "";
    try {
      validateReadQueryTables(q);
    } catch (e) {
      accepted = false;
      why = (e as Error).message;
    }
    record(accepted, `parser allows: ${q}${accepted ? "" : `  (${why})`}`);
  }

  await ensureMcpReadRole();
  // Hard DB-level denials (SQLSTATE 42501 from Postgres itself).
  for (const probe of ["users", "sessions", "pg_authid", "pg_shadow"]) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      await c.query("SET LOCAL ROLE mcp_read_only");
      let denied = false;
      let code = "";
      try {
        await c.query(`SELECT 1 FROM ${probe} LIMIT 1`);
      } catch (e) {
        code = (e as { code?: string }).code ?? "";
        denied = code === "42501";
      }
      record(denied, `db denies ${probe} (sqlstate=${code})`);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  }

  // Filtered-catalog probes. PUBLIC has SELECT on these views and that
  // grant cannot be revoked per-role in standard Postgres, but
  // Postgres applies built-in non-superuser filtering so the data
  // they expose under `mcp_read_only` is non-sensitive. We assert
  // that filtering rather than expecting a permission error.
  const cFilt = await pool.connect();
  try {
    await cFilt.query("BEGIN READ ONLY");
    await cFilt.query("SET LOCAL ROLE mcp_read_only");

    const pgUser = await cFilt.query("SELECT usename, passwd FROM pg_user");
    const allMasked = pgUser.rows.every((r) => r.passwd === "********");
    record(allMasked, `pg_user.passwd is masked for all ${pgUser.rowCount} rows`);

    const myPidRow = await cFilt.query("SELECT pg_backend_pid() AS pid");
    const myPid = myPidRow.rows[0].pid as number;
    const psa = await cFilt.query(
      "SELECT pid, usename, query FROM pg_stat_activity WHERE pid <> $1",
      [myPid]
    );
    const allHidden = psa.rows.every(
      (r) => r.query === "<insufficient privilege>" || r.query === null
    );
    record(
      allHidden,
      `pg_stat_activity.query hidden for all ${psa.rowCount} other sessions`
    );

    const infoSchema = await cFilt.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY 1,2`
    );
    const visibleNames = infoSchema.rows.map((r) => r.table_name).sort();
    const expected = [
      "gift_cards",
      "intercard_revenue",
      "order_line_items",
      "orders",
      "payout_fee_entries",
      "refunds",
      "transactions",
    ];
    const matches =
      visibleNames.length === expected.length &&
      visibleNames.every((n, i) => n === expected[i]);
    record(
      matches,
      `information_schema.tables exposes only the ${expected.length} allow-listed tables (saw ${visibleNames.length}: ${visibleNames.join(",")})`
    );
  } finally {
    await cFilt.query("ROLLBACK").catch(() => {});
    cFilt.release();
  }

  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL ROLE mcp_read_only");
    let ok = false;
    try {
      await c.query("SELECT 1 FROM orders WHERE 1=0");
      ok = true;
    } catch (e) {
      ok = false;
      console.log("positive probe error:", (e as Error).message);
    }
    record(ok, "db allows: SELECT 1 FROM orders WHERE 1=0");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }

  await pool.end();
  if (failures > 0) {
    console.error(`\n${failures} probe(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${blocked.length + allowed.length + 4} probes passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
