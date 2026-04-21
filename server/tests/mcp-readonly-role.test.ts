import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ensureMcpReadRole, MCP_READ_ROLE } from '../db';

/**
 * Automated probe for the MCP run_read_query role lockdown (Task #64).
 *
 * Re-runs the by-hand check from Task #53 every time the test suite
 * runs. Opens a transaction, switches into the dedicated read-only
 * Postgres role used by the MCP run_read_query tool, and asserts that
 * Postgres itself blocks SELECTs against sensitive tables while still
 * allowing SELECTs on the business-table allow-list. If a future schema
 * migration, role-grant change, or refactor of the MCP transaction
 * setup re-opens access, this test fails loudly so it cannot land
 * unnoticed.
 *
 * Uses node-postgres directly (not the Neon serverless driver) because
 * the WebSocket driver crashes with "Cannot set property message" when
 * surfacing Postgres permission errors — the same workaround as
 * scripts/verify-mcp-hardening.ts.
 */
describe('MCP read-only role lockdown', () => {
  let client: pg.Client;
  let connected = false;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set to run this test');
    }
    await ensureMcpReadRole();
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    connected = true;
  });

  afterAll(async () => {
    if (connected) await client.end().catch(() => {});
  });

  async function runUnderReadRole(probeSql: string): Promise<{
    rows: unknown[] | null;
    code: string | null;
    message: string | null;
  }> {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL ROLE ${MCP_READ_ROLE}`);
    try {
      const result = await client.query(probeSql);
      return { rows: result.rows, code: null, message: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { rows: null, code: err.code ?? '', message: err.message ?? '' };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  }

  it('denies SELECT on pg_shadow with a Postgres permission error', async () => {
    const result = await runUnderReadRole('SELECT 1 FROM pg_shadow LIMIT 1');
    expect(result.rows).toBeNull();
    // 42501 = insufficient_privilege. pg_shadow always exists in a
    // Postgres cluster, so any other outcome means the role can read it.
    expect(result.code).toBe('42501');
  });

  it('denies SELECT on the application users table with a Postgres permission error', async () => {
    const result = await runUnderReadRole('SELECT 1 FROM users LIMIT 1');
    expect(result.rows).toBeNull();
    expect(result.code).toBe('42501');
  });

  it('allows SELECT on the orders business table', async () => {
    const result = await runUnderReadRole('SELECT 1 FROM orders LIMIT 1');
    expect(result.code).toBeNull();
    expect(Array.isArray(result.rows)).toBe(true);
  });
});
