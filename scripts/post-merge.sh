#!/bin/bash
set -e
npm install
# --force so drizzle-kit doesn't prompt about destructive/data-loss
# situations (e.g. adding a unique constraint to a table with existing
# rows). Stdin is closed during post-merge, so any prompt would hang.
npm run db:push -- --force

# Run the automated test suite (Task #71). The vitest suite under
# server/tests/ holds the safety probes — anti-enumeration on the
# password-reset flow, the MCP read-only role lockdown, the Square
# rate-limit alerter, and the order/timestamp domain logic. Any
# regression should block the merge from being declared healthy, so we
# rely on `set -e` above to abort this script on a non-zero exit.
#
# Invoked via `npx --no-install` so a missing dev dependency surfaces
# as a clear failure rather than silently installing a different
# version. `vitest run` (single-shot, non-watch) is the only mode safe
# for an unattended hook — `vitest` with no args defaults to watch
# mode in a TTY.
npx --no-install vitest run
