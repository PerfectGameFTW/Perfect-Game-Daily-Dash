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
import pg from "pg";

// Silence a known crash in @neondatabase/serverless when the WebSocket
// driver tries to mutate `event.message` on a non-writable ErrorEvent
// while reporting a stream error. The probes below intentionally
// trigger Postgres permission errors, which seems to surface this
// driver bug; we don't want it to abort the verification run.
process.on("uncaughtException", (err) => {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes("Cannot set property message")) return;
  throw err;
});

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
  // Close the Neon WebSocket pool — DB-level probes use a plain
  // node-postgres TCP client to avoid a known crash in the Neon
  // serverless driver when handling Postgres permission errors
  // (`Cannot set property message of #<ErrorEvent>`).
  await pool.end().catch(() => {});

  const probeClient = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  await probeClient.connect();

  // Hard DB-level denials (SQLSTATE 42501 from Postgres itself, or
  // 42P01 if the table doesn't exist in this environment — both
  // outcomes mean `mcp_read_only` cannot read the surface). Every
  // object listed in Task #53's "no access" requirement is probed
  // here; each one MUST come back as denied. If any return rows,
  // the role lockdown is incomplete on this database — see the
  // remediation message at the end of this file.
  // For surfaces that always exist in a Postgres cluster (the system
  // catalogs and information_schema) and for the application's own
  // `users` table, we require strict 42501 (insufficient_privilege)
  // because anything else would mean the role can actually read the
  // surface. For surfaces that may legitimately be absent in some
  // environments (e.g. `sessions` when the deployment uses a non-DB
  // session store), 42P01 (undefined_table) is also accepted — the
  // role still has no path to read what isn't there.
  const deniedProbes: Array<{
    table: string;
    probeSql: string;
    allowUndefined?: boolean;
  }> = [
    { table: "users", probeSql: "SELECT 1 FROM users LIMIT 1" },
    { table: "sessions", probeSql: "SELECT 1 FROM sessions LIMIT 1", allowUndefined: true },
    { table: "pg_authid", probeSql: "SELECT 1 FROM pg_authid LIMIT 1" },
    { table: "pg_shadow", probeSql: "SELECT 1 FROM pg_shadow LIMIT 1" },
    { table: "pg_user", probeSql: "SELECT 1 FROM pg_user LIMIT 1" },
    {
      table: "pg_stat_activity",
      probeSql: "SELECT 1 FROM pg_stat_activity LIMIT 1",
    },
    {
      table: "information_schema.tables",
      probeSql: "SELECT 1 FROM information_schema.tables LIMIT 1",
    },
  ];
  let publicGrantFailures = 0;
  for (const { table, probeSql, allowUndefined } of deniedProbes) {
    await probeClient.query("BEGIN READ ONLY");
    await probeClient.query("SET LOCAL ROLE mcp_read_only");
    let denied = false;
    let code = "";
    try {
      await probeClient.query(probeSql);
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      denied = code === "42501" || (allowUndefined === true && code === "42P01");
    }
    await probeClient.query("ROLLBACK").catch(() => {});
    record(denied, `db denies ${table} (sqlstate=${code || "<none>"})`);
    // Only PUBLIC-grant surfaces (the catalog views and
    // information_schema) trigger the operator-script remediation
    // hint — denials on the seven app-layer tables don't need it.
    if (!denied && /^pg_|^information_schema/.test(table)) {
      publicGrantFailures += 1;
    }
  }

  // Positive probe — make sure legitimate business queries still
  // succeed under the restricted role.
  await probeClient.query("BEGIN READ ONLY");
  await probeClient.query("SET LOCAL ROLE mcp_read_only");
  let ok = false;
  try {
    await probeClient.query("SELECT 1 FROM orders WHERE 1=0");
    ok = true;
  } catch (e) {
    ok = false;
    console.log("positive probe error:", (e as Error).message);
  }
  await probeClient.query("ROLLBACK").catch(() => {});
  record(ok, "db allows: SELECT 1 FROM orders WHERE 1=0");

  await probeClient.end();
  if (failures > 0) {
    console.error(`\n${failures} probe(s) failed`);
    if (publicGrantFailures > 0) {
      console.error(
        `\n${publicGrantFailures} of those failures are PUBLIC-grant\n` +
          `denials on system catalog views or information_schema. The\n` +
          `application database role cannot revoke those grants on\n` +
          `managed Postgres providers (e.g. Neon) because PUBLIC's\n` +
          `grants there are owned by a platform superuser.\n\n` +
          `To complete the lockdown, an operator must run:\n` +
          `    psql "$ADMIN_DATABASE_URL" \\\n` +
          `        -f scripts/setup-mcp-readonly-role.sql\n` +
          `using a privileged connection (Neon's "Connect as" admin\n` +
          `role, or any superuser on self-hosted Postgres). After that\n` +
          `re-run this verification script.`
      );
    }
    process.exit(1);
  }
  const totalProbes =
    blocked.length + allowed.length + deniedProbes.length + 1;
  console.log(`\nAll ${totalProbes} probes passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
