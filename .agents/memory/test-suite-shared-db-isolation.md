---
name: Test suite shared-DB isolation
description: Why the vitest suite must run files serially, and the Postgres row-lock waiter quirk its lock-wait helpers depend on.
---

# Vitest suite runs on ONE shared test DB — keep files serial

The whole vitest suite runs against a single sibling `<live>_test` database (`globalSetup` truncates it once per run and uses an advisory lock to serialize *separate* `vitest run` invocations). Several test files mutate **global singleton rows in `app_settings`** — most importantly the deployment-wide **require-admin-2FA** toggle and the Square-rate-limit-alert setting.

**Rule:** keep `fileParallelism: false` in `vitest.config.ts`.

**Why:** With file-level parallelism, when one file flips the require-admin-2FA toggle ON, `requireAuth` starts rejecting EVERY admin-authenticated request in *other* concurrently-running files with `403 TOTP_ENROLLMENT_REQUIRED`. The victim file changes run-to-run, so failures look like random flakes. Per-file cleanup can't fix it — the "on" window overlaps concurrent files by construction. Serial files matches globalSetup's single-logical-run assumption.

**How to apply:** Do NOT "optimize" CI by re-enabling parallelism unless test isolation is first redesigned (per-file DB/schema, or fully namespaced per-file `app_settings` keys). Validate the full suite in serial chunks via separate `vitest run` invocations (advisory-lock-serialized) when one run exceeds the shell time cap.

# Postgres row-lock waiters queue in TWO stages (pg_locks)

When multiple backends wait on the same `SELECT ... FOR UPDATE` row:
- The **first** waiter blocks on a `ShareLock` of the holder's `transactionid` (`pg_locks`: `locktype='transactionid'`, `transactionid=<holder xid>`, `granted=false`).
- The **second and later** waiters block *earlier*, on a `tuple` lock for that row (`pg_locks`: `locktype='tuple'`, `relation=<oid>`, `page`/`tuple`, `granted=false`).

**Why it matters:** Counting only `transactionid` waiters caps at 1 — you will never observe waiter depth ≥2. To detect N queued waiters scoped to one row, **sum both** lock types (transactionid + tuple) for that specific row.

**How to apply:** Capture the holder's real xid (it gets one after `FOR UPDATE` writes `xmax`) and the row's `ctid`/relation from the holder's OWN connection (reliable under Neon's WS pooler, unlike correlating pids across clients via `pg_blocking_pids`). The ctid is stable while the holder keeps the lock and no waiter has updated/re-versioned the row yet. Used by the lock-ordering tests in `server/tests/totpRecoveryRegenerate.test.ts`.
