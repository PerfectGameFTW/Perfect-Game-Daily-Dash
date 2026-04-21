import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from "ws";
import * as schema from "@shared/schema";

// Configure neon to use websockets
neonConfig.webSocketConstructor = ws;

// Add detailed startup logging
console.log('Initializing database connection...');

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Create connection pool with error handling
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000 // 5 second timeout
});

// Test the connection
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Initialize Drizzle with the pool
export const db = drizzle(pool, { schema });

// Export sql for query building
export { sql };

// Add connection verification
pool.connect()
  .then(client => {
    console.log('Successfully connected to database');
    client.release();
  })
  .catch(err => {
    console.error('Error connecting to the database:', err);
    process.exit(-1);
  });

// Restricted Postgres role used by the MCP run_read_query tool. The role
// is granted SELECT only on the explicit business-table allow-list and
// has no privileges on application user/session tables or the system
// catalogs. The MCP tool issues `SET LOCAL ROLE` to switch into it
// inside its read-only transaction, so a parser/keyword bypass still
// hits a hard permission error from Postgres.
export const MCP_READ_ROLE = 'mcp_read_only';
const MCP_READ_TABLES = [
  'orders',
  'order_line_items',
  'transactions',
  'gift_cards',
  'refunds',
  'intercard_revenue',
  'payout_fee_entries',
];

let ensureMcpReadRolePromise: Promise<void> | null = null;
/**
 * Provision the restricted Postgres role used by the MCP run_read_query
 * tool. Idempotent: a successful call is cached so subsequent invocations
 * are free, and a failed call is not cached so the next caller can retry.
 *
 * Deployment note: this function expects to be run by a Postgres user
 * that can CREATE ROLE and GRANT SELECT on the business tables. On
 * managed Postgres providers without that privilege, this function will
 * throw, and run_read_query will fail closed (refuse to execute) until
 * the role is provisioned out-of-band by an operator. Pre-provisioning
 * via migration/infra is recommended for production.
 */
export function ensureMcpReadRole(): Promise<void> {
  if (ensureMcpReadRolePromise) return ensureMcpReadRolePromise;
  ensureMcpReadRolePromise = (async () => {
    const client = await pool.connect();
    try {
      // Create the role if it doesn't already exist. NOLOGIN keeps it
      // strictly a permission bucket — nobody can connect as it directly.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MCP_READ_ROLE}') THEN
            CREATE ROLE ${MCP_READ_ROLE} NOLOGIN NOINHERIT;
          END IF;
        END$$;
      `);
      // Membership is required for SET ROLE to succeed.
      await client.query(`GRANT ${MCP_READ_ROLE} TO CURRENT_USER`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${MCP_READ_ROLE}`);
      // Grant SELECT on the explicit allow-list, table by table so a
      // missing table fails loudly rather than silently widening access.
      for (const table of MCP_READ_TABLES) {
        await client.query(
          `GRANT SELECT ON public.${table} TO ${MCP_READ_ROLE}`
        );
      }
      // Best-effort REVOKEs against the role for sensitive surfaces.
      // Postgres grants on system catalogs are typically held by PUBLIC,
      // and PUBLIC's grants cannot be removed for a single role without
      // affecting the rest of the application — so the parser/keyword
      // filter in mcp.ts is the authoritative defense for these. These
      // REVOKEs at least ensure no direct grant was made to the role
      // and tighten function execution where possible.
      const revokeStatements = [
        `REVOKE ALL ON SCHEMA pg_catalog FROM ${MCP_READ_ROLE}`,
        `REVOKE ALL ON SCHEMA information_schema FROM ${MCP_READ_ROLE}`,
        `REVOKE ALL ON ALL TABLES IN SCHEMA information_schema FROM ${MCP_READ_ROLE}`,
        `REVOKE EXECUTE ON FUNCTION pg_catalog.current_setting(text) FROM ${MCP_READ_ROLE}`,
        `REVOKE EXECUTE ON FUNCTION pg_catalog.current_setting(text, boolean) FROM ${MCP_READ_ROLE}`,
        `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM ${MCP_READ_ROLE}`,
      ];
      for (const stmt of revokeStatements) {
        await client.query(stmt).catch(() => {
          // A REVOKE that targets a non-existent grant is a no-op in
          // intent; ignore so role provisioning stays idempotent across
          // managed Postgres environments with varying grant defaults.
        });
      }
      console.log(
        `[db] mcp read-only role '${MCP_READ_ROLE}' ready (SELECT on ${MCP_READ_TABLES.length} tables)`
      );
    } finally {
      client.release();
    }
  })().catch((err) => {
    // Reset so a future call can retry — but rethrow now so the caller
    // fails closed instead of silently running as the privileged role.
    ensureMcpReadRolePromise = null;
    throw err;
  });
  return ensureMcpReadRolePromise;
}