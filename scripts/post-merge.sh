#!/bin/bash
set -e
npm install
# --force so drizzle-kit doesn't prompt about destructive/data-loss
# situations (e.g. adding a unique constraint to a table with existing
# rows). Stdin is closed during post-merge, so any prompt would hang.
npm run db:push -- --force
