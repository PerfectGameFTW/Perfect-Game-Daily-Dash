#!/bin/bash
set -e
npm install
# --force so drizzle-kit doesn't prompt about destructive/data-loss
# situations (e.g. adding a unique constraint to a table with existing
# rows). Stdin is closed during post-merge, so any prompt would hang.
npm run db:push -- --force

# ---------------------------------------------------------------------------
# Isolated test-database provisioning (Task #106)
# ---------------------------------------------------------------------------
# Every previous version of this script ran `vitest run` against the live
# application DATABASE_URL. The suite writes to real `orders`, `users`,
# and `password_reset_tokens` rows and grants real Postgres roles, so
# any aborted cleanup left orphan data in production and two concurrent
# merge hooks could collide on the same fixture rows.
#
# The fix is structural: we provision a sibling database (defaulting to
# `<live-db>_test`), push the same schema to it, and run vitest with
# DATABASE_URL pointed at that test DB. The vitest setup file
# (server/tests/setup.ts) ALSO refuses to start if its resolved URL
# equals the live DATABASE_URL — defense in depth in case this script
# is ever bypassed.
#
# Operator override: set TEST_DATABASE_URL in the environment to pin
# the suite to an explicit isolated database (e.g. one on a different
# host); ensure-test-db.ts will use it as-is and skip provisioning.

# `npx --no-install tsx` runs the helper without a global install. The
# helper writes the resolved TEST_DATABASE_URL to stdout (last line)
# and any human-readable status to stderr, so we capture only stdout.
TEST_DATABASE_URL=$(npx --no-install tsx scripts/ensure-test-db.ts)
export TEST_DATABASE_URL

if [ -z "$TEST_DATABASE_URL" ]; then
  echo "[post-merge] FATAL: ensure-test-db.ts did not return a TEST_DATABASE_URL." >&2
  exit 1
fi
if [ "$TEST_DATABASE_URL" = "$DATABASE_URL" ]; then
  echo "[post-merge] FATAL: TEST_DATABASE_URL equals DATABASE_URL — refusing to run tests against the live database." >&2
  exit 1
fi

# Push the schema into the test DB. Subshell + DATABASE_URL override
# keeps drizzle-kit pointed at the test target without leaking the
# rewrite into the rest of this script (we need the live DATABASE_URL
# to remain visible if any later step uses it).
( DATABASE_URL="$TEST_DATABASE_URL" npm run db:push -- --force )

# Run the automated test suite (Task #71). The vitest suite under
# server/tests/ holds the safety probes — anti-enumeration on the
# password-reset flow, the MCP read-only role lockdown, the Square
# rate-limit alerter, and the order/timestamp domain logic. Any
# regression should block the merge from being declared healthy, so we
# rely on `set -e` above to abort this script on a non-zero exit.
#
# Invoked via `npm test`, which package.json defines as `vitest run`
# (single-shot, non-watch — the only mode safe for an unattended hook;
# `vitest` with no args defaults to watch mode in a TTY). npm resolves
# the binary from the locally installed devDependency, so a missing
# dependency surfaces as a clear failure rather than silently
# installing a different version.
#
# server/tests/setup.ts will read TEST_DATABASE_URL (exported above)
# and rewrite process.env.DATABASE_URL before any test imports the db.
#
# Concurrency note (Task #139):
#   server/tests/globalSetup.ts acquires a Postgres advisory lock on
#   the test DB before truncating it, and holds the lock for the entire
#   `vitest run`. So if two post-merge hooks (or a developer running
#   `npm test` while CI is mid-flight) target the same Postgres host,
#   the second `npm test` BLOCKS at globalSetup until the first run's
#   teardown releases the lock. Runs are serialized — they do not
#   each get their own ephemeral DB. Expect the second run to spend
#   extra time waiting at startup; the lock wait is bounded at 15
#   minutes via Postgres `lock_timeout` so a stuck previous run
#   surfaces a clear error instead of hanging this hook indefinitely.
npm test
