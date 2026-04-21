/**
 * Bootstrap the first admin user.
 *
 * Run out-of-band (NOT via HTTP) to create the very first admin account on a
 * fresh database. The HTTP /api/auth/register endpoint is admin-only and will
 * not let an anonymous caller create any account, including the first one.
 *
 * Usage:
 *   INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD='strong-pw' \
 *     tsx scripts/bootstrap-admin.ts
 *
 *   # or pass on the command line:
 *   tsx scripts/bootstrap-admin.ts <username> <password>
 *
 * The bootstrap is concurrency-safe: a Postgres advisory lock guards a
 * transactional check-and-insert, so two concurrent runs cannot both create
 * an admin. If an admin already exists, this script refuses to create a
 * second one (use the admin UI / POST /api/auth/register as an authenticated
 * admin to create additional users instead).
 */

import 'dotenv/config';
import { authService } from '../server/services/authService';
import { pool } from '../server/db';

async function main() {
  const username = process.argv[2] ?? process.env.INITIAL_ADMIN_USERNAME;
  const password = process.argv[3] ?? process.env.INITIAL_ADMIN_PASSWORD;

  if (!username || !password) {
    console.error(
      'Missing credentials. Provide INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD ' +
        'env vars, or pass <username> <password> as CLI args.'
    );
    process.exit(2);
  }

  if (username.length < 3 || username.length > 50) {
    console.error('Username must be 3-50 characters.');
    process.exit(2);
  }

  if (password.length < 12) {
    console.error('Password must be at least 12 characters for the bootstrap admin.');
    process.exit(2);
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    console.error('Password must contain at least one letter and one digit.');
    process.exit(2);
  }

  try {
    const user = await authService.bootstrapInitialAdmin(username, password);
    console.log(`✓ Bootstrapped admin user '${user.username}' (id=${user.id}).`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ Bootstrap failed: ${message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();
