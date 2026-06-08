import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { db, pool } from '../db';
import { users } from '@shared/schema';
import { authService } from '../services/authService';
import { totpService } from '../services/totpService';
import { createAuthRouter } from '../routes/auth';
import { decryptTotpSecret } from '../services/totpCrypto';
import { verifyPassword } from '../services/passwordHash';
import {
  totpRecoveryRegenerateAccountLimiter,
  totpRecoveryRegenerateIpLimiter,
} from '../middleware/rateLimiter';
import type { TotpLoginResult } from '../services/totpService';

type PoolClientLike = Awaited<ReturnType<typeof pool.connect>>;

// Identifies the exact row lock held by the sentinel connection so that
// waits below can be scoped to THIS test's lock conflict only — other
// test files run concurrently in the same `vitest run` and share this DB.
interface RowLockTarget {
  // The sentinel transaction's real 32-bit xid (the FIRST waiter blocks
  // on a ShareLock of this).
  xid: string;
  // relation oid + page/tuple of the locked row (SUBSEQUENT waiters block
  // on a `tuple` lock identified by these — see waitUntilQueuedWaiters).
  reloid: string;
  page: number;
  tuple: number;
}

// Captures the sentinel's row-lock identity AFTER it has taken a row lock.
// `SELECT ... FOR UPDATE` writes the row's xmax, which forces the
// transaction to be assigned a real xid, so `backend_xid` is populated by
// then. We read both the xid and the row's ctid via SELF lookups on the
// sentinel's OWN connection — reliable even under Neon's serverless WS
// pooler, unlike correlating a pid seen by one client with the pid
// `pg_blocking_pids()` reports from another client (NOT reliable under the
// pooler). The ctid is stable for the duration of the wait: a pure
// FOR UPDATE lock does not move the tuple, and we release the sentinel
// before any waiter is allowed to UPDATE (and thus re-version) the row.
async function getSentinelLockTarget(
  blocker: PoolClientLike,
  userId: number,
): Promise<RowLockTarget> {
  const x = await blocker.query<{ xid: string | null }>(
    `SELECT backend_xid::text AS xid
       FROM pg_stat_activity
      WHERE pid = pg_backend_pid()`,
  );
  const xid = x.rows[0]?.xid;
  if (!xid || xid === '0') {
    throw new Error(
      'sentinel transaction has no real xid — acquire SELECT ... FOR UPDATE before reading it',
    );
  }
  const c = await blocker.query<{ ctid: string; reloid: string }>(
    `SELECT ctid::text AS ctid,
            'public.users'::regclass::oid::text AS reloid
       FROM users
      WHERE id = $1`,
    [userId],
  );
  const ctid = c.rows[0]?.ctid;
  const reloid = c.rows[0]?.reloid;
  if (!ctid || !reloid) {
    throw new Error('could not resolve sentinel row ctid/relation');
  }
  const m = ctid.match(/^\((\d+),(\d+)\)$/);
  if (!m) {
    throw new Error(`unexpected ctid format: ${ctid}`);
  }
  return { xid, reloid, page: Number(m[1]), tuple: Number(m[2]) };
}

// Polls until at least `expected` backends are queued behind the
// sentinel's row lock, scoped to THIS test's specific row.
//
// Postgres serializes row-lock waiters in two stages, so the waiters do
// NOT all wait on the same lock object:
//   - The FIRST waiter requests a ShareLock on the holder's
//     `transactionid` — pg_locks row (locktype='transactionid',
//     transactionid=<sentinel xid>, granted=false).
//   - SUBSEQUENT waiters block earlier, on a `tuple` lock for the row that
//     the first waiter already holds — pg_locks row (locktype='tuple',
//     relation=<users oid>, page/tuple=<row>, granted=false).
// Counting ONLY the transactionid waiters therefore caps at 1; we must sum
// both lock types, each scoped to this row, to observe the second waiter.
//
// This replaces an earlier "count ALL blocked backends on the database"
// poll whose correctness relied on no other traffic sharing the DB. That
// premise only holds ACROSS vitest runs (the globalSetup advisory lock
// serializes separate runs); WITHIN a single run every test file shares
// this DB in concurrent forks, so a global blocked-backend count could
// return early on an unrelated test's lock wait and break this test's
// deterministic sequencing — which is exactly how it began failing under
// the suite's parallel scheduling.
//
// In this controlled scenario (same row, same lock conflict class, no
// NOWAIT/SKIP LOCKED, no statement cancellation) Postgres serves the
// queued waiters in arrival order (transactionid waiter first, then the
// tuple waiter), so gating each fire on this helper gives us a
// deterministic execution sequence.
async function waitUntilQueuedWaiters(
  target: RowLockTarget,
  expected: number,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query<{ count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM pg_locks
            WHERE locktype = 'transactionid'
              AND transactionid = $1::xid
              AND NOT granted)
         + (SELECT COUNT(*) FROM pg_locks
            WHERE locktype = 'tuple'
              AND relation = $2::oid
              AND page = $3
              AND tuple = $4
              AND NOT granted)
       )::text AS count`,
      [target.xid, target.reloid, target.page, target.tuple],
    );
    if (Number(r.rows[0]?.count ?? '0') >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${expected} queued waiter(s) on row ` +
      `(xid ${target.xid}, ctid (${target.page},${target.tuple}))`,
  );
}

let __ip = 0;
function uniqueIp(): string {
  __ip += 1;
  return `192.0.2.${(__ip % 254) + 1}`;
}

interface JsonResp {
  status: number;
  body: any;
  cookie: string | null;
}
async function jsonReq(
  url: string,
  method: 'GET' | 'POST',
  payload: unknown,
  cookie?: string,
  ipOverride?: string,
): Promise<JsonResp> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ipOverride ?? uniqueIp(),
  };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, cookie: r.headers.get('set-cookie') };
}

const USERNAME = '__totp_regen_user__';
const PWD = 'Regen!Codes-Test-Pwd-44';

function currentCode(secretBase32: string): string {
  const totp = new TOTP({
    issuer: 'Perfect Game Sales Dashboard',
    label: USERNAME,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.generate();
}

describe('Regenerate TOTP recovery codes (Task #101)', () => {
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let userId: number;
  let secretBase32: string;

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, USERNAME));
    const u = await authService.registerUser(USERNAME, PWD, 'admin');
    userId = u.id;

    app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use(
      session({
        name: 'pgs.sid',
        secret: 'test-secret-do-not-use-elsewhere',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax', secure: false },
      }),
    );
    app.use('/api/auth', createAuthRouter());
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  beforeEach(async () => {
    // Fresh enrollment for every test: begin → flip totpEnabled true and
    // seed a known recovery batch we can later assert is wiped.
    const enrollment = await totpService.beginEnrollment({
      ...(await authService.getUserById(userId))!,
    } as any);
    secretBase32 = enrollment.secret;
    await db
      .update(users)
      .set({
        totpEnabled: true,
        totpRecoveryCodes: ['$argon2id$placeholder'],
        // Clear any per-account lockout state left over from a previous
        // test that hit loginUser with a wrong password — the throttle
        // tests below intentionally exceed the 5-strike lockout
        // threshold to drain the rate-limit bucket.
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
    // Reset the regenerate-throttle bucket for this user so a previous
    // test that drained it doesn't leave the next test pre-throttled.
    // Per-IP buckets are naturally isolated by uniqueIp() in jsonReq.
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);
  });

  // Drains the per-account password-lockout state so a tight loop of
  // wrong-password requests can exercise the rate limiter without
  // tripping the unrelated lockout-after-5-failures defense.
  async function resetAccountLockout(): Promise<void> {
    await db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, userId));
    authService.invalidateUserCache(userId);
  }

  async function login(): Promise<string> {
    const r1 = await jsonReq(`${baseUrl}/api/auth/login`, 'POST', {
      username: USERNAME,
      password: PWD,
    });
    expect(r1.body.requiresTotp).toBe(true);
    const cookie = r1.cookie!.split(';')[0];
    const r2 = await jsonReq(
      `${baseUrl}/api/auth/totp/verify`,
      'POST',
      { code: currentCode(secretBase32) },
      cookie,
    );
    expect(r2.status).toBe(200);
    // The verify response usually rotates the cookie — use whichever
    // value the server hands back.
    return (r2.cookie ?? r1.cookie!).split(';')[0];
  }

  it('returns 10 fresh codes and rotates the stored hash batch when password + TOTP are correct', async () => {
    const cookie = await login();
    const before = await db.select().from(users).where(eq(users.id, userId));
    const oldHashes = before[0]?.totpRecoveryCodes ?? [];

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(Array.isArray(r.body.recoveryCodes)).toBe(true);
    expect(r.body.recoveryCodes).toHaveLength(10);
    // Format: XXXXX-XXXXX with the Crockford-ish alphabet.
    for (const c of r.body.recoveryCodes) {
      expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }

    const after = await db.select().from(users).where(eq(users.id, userId));
    const newHashes = after[0]?.totpRecoveryCodes ?? [];
    expect(newHashes).toHaveLength(10);
    // None of the new hashes should match any of the old ones.
    for (const h of newHashes) {
      expect(oldHashes).not.toContain(h);
    }
    // And the new plaintext should verify against the new hashes (one
    // each, in some order).
    for (const code of r.body.recoveryCodes as string[]) {
      const stripped = code.replace('-', '');
      // eslint-disable-next-line no-await-in-loop
      const matches = await Promise.all(newHashes.map((h) => verifyPassword(stripped, h)));
      expect(matches.filter(Boolean)).toHaveLength(1);
    }
    // totpLastUsedAt should have been refreshed.
    expect(after[0]?.totpLastUsedAt).toBeTruthy();
  });

  it('previous recovery codes stop working as soon as the batch is regenerated', { timeout: 20000 }, async () => {
    const cookie = await login();
    // Seed one known recovery code by enrolling the proper way.
    const verifyResult = await totpService.verifyAndEnable(userId, currentCode(secretBase32));
    expect(verifyResult).not.toBeNull();
    const oldCodes = verifyResult!;
    // Sanity: the seeded code verifies.
    expect((await totpService.verifyLoginCode(userId, oldCodes[0])).ok).toBe(true);
    // Re-seed a second usable code (the verify above consumed one).
    const verifyResult2 = await totpService.verifyAndEnable(userId, currentCode(secretBase32));
    const oldBatch = verifyResult2!;

    // Regenerate via the endpoint.
    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(200);

    // Every previously-issued code should now be rejected.
    for (const c of oldBatch) {
      // eslint-disable-next-line no-await-in-loop
      expect((await totpService.verifyLoginCode(userId, c)).ok).toBe(false);
    }
    // A code from the new batch should be accepted exactly once.
    const newCode = (r.body.recoveryCodes as string[])[0];
    expect((await totpService.verifyLoginCode(userId, newCode)).ok).toBe(true);
    expect((await totpService.verifyLoginCode(userId, newCode)).ok).toBe(false);
  });

  it('rejects with 401 when the password is wrong (and does not rotate codes)', async () => {
    const cookie = await login();
    const before = await db.select().from(users).where(eq(users.id, userId));

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(401);

    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(before[0]?.totpRecoveryCodes);
  });

  it('rejects when the TOTP code is wrong (and does not rotate codes)', async () => {
    const cookie = await login();
    const before = await db.select().from(users).where(eq(users.id, userId));

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: '000000' },
      cookie,
    );
    expect(r.status).toBe(400);

    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(before[0]?.totpRecoveryCodes);
  });

  it('rejects a recovery code in the TOTP slot — only live authenticator codes unlock regeneration', async () => {
    const cookie = await login();
    // Get a real plaintext recovery code via verifyAndEnable.
    const codes = (await totpService.verifyAndEnable(userId, currentCode(secretBase32)))!;
    const recoveryCode = codes[0];
    const before = await db.select().from(users).where(eq(users.id, userId));

    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: recoveryCode },
      cookie,
    );
    expect(r.status).toBe(400);

    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(before[0]?.totpRecoveryCodes);
  });

  it('requires authentication', async () => {
    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
    );
    expect(r.status).toBe(401);
  });

  it('regenerate blocks behind a held row lock and produces a clean batch when released — deterministic FOR UPDATE proof', { timeout: 30000 }, async () => {
    // Deterministic replacement for an earlier `Promise.all`-style
    // race test (Task #130). The previous version fired
    // `verifyLoginCode` and the regenerate HTTP call concurrently and
    // hoped the two operations actually overlapped in time. They
    // often did not (the in-process function call beat the HTTP round
    // trip every run on most machines), and the only assertion about
    // ordering was `expect(typeof outcome.ok === 'boolean').toBe(true)`
    // — a tautology. The test could pass without ever exercising the
    // FOR UPDATE serialization it was meant to cover.
    //
    // This version drives the contention deterministically:
    //   1. Lease a dedicated pg client and acquire `SELECT ... FOR
    //      UPDATE` on the user row from the test itself.
    //   2. Kick off `regenerateRecoveryCodes` (do NOT await). It will
    //      block at its own `for('update')` because Postgres serializes
    //      conflicting row locks — this is a guaranteed wait, not a
    //      hoped-for one.
    //   3. Observe the wait via pg_stat_activity. Postgres exposes
    //      `wait_event_type='Lock' / wait_event='transactionid'` on
    //      the blocked backend, so we can poll for it directly. The
    //      poll loop terminates as soon as the wait appears (which it
    //      MUST, given the lock semantics) — there is no fixed sleep.
    //   4. While regen is blocked, snapshot the row to prove it is
    //      still pre-regen state (no half-applied write).
    //   5. Commit our transaction → release the lock → regen runs to
    //      completion. Assert the final state contains only the new
    //      batch hashes.
    //
    // If a future refactor removed the `for('update')` from
    // `regenerateRecoveryCodes`, regen would NOT block here, the
    // pg_stat_activity poll would time out, and this test would fail
    // loudly — which is exactly the regression we want to catch.
    await login();
    const oldBatch = (await totpService.verifyAndEnable(userId, currentCode(secretBase32)))!;
    expect(oldBatch.length).toBeGreaterThanOrEqual(2);
    const beforeRegen = await db.select().from(users).where(eq(users.id, userId));
    const oldHashes = beforeRegen[0]!.totpRecoveryCodes ?? [];
    expect(oldHashes.length).toBeGreaterThan(0);

    // Note: this deterministic-contention pattern requires pool capacity
    // >= 2 (one client to hold the blocker lock, one for regen). The
    // app pool is sized well above that; if a future test infrastructure
    // change shrinks it, this test will time out at the lock-wait poll
    // — caller-visible failure, not a silent skip.
    const blocker = await pool.connect();
    let blockerCommitted = false;
    let regenPromise: Promise<string[] | null> | null = null;
    try {
      await blocker.query('BEGIN');
      // Same lock target regenerate's transaction will reach for.
      await blocker.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      // The sentinel now holds the row lock; capture its lock identity so
      // we can scope the wait poll to THIS lock conflict only (other
      // concurrent test files share this DB — see waitUntilQueuedWaiters).
      const lockTarget = await getSentinelLockTarget(blocker, userId);

      // Fire regenerate but DO NOT await — it must reach its
      // `for('update')` and then block on our held lock. We attach
      // `.catch(() => {})` only to silence the unhandled-rejection
      // bookkeeping during the poll; the real outcome is awaited
      // (and re-thrown) at the end of the try block, and the finally
      // drains it on every error path.
      regenPromise = totpService.regenerateRecoveryCodes(
        userId,
        currentCode(secretBase32),
      );
      regenPromise.catch(() => {});

      // Wait until regen is observed queued behind OUR sentinel's row
      // lock. The condition is guaranteed to become true given Postgres's
      // lock semantics; waitUntilQueuedWaiters throws on timeout, which is
      // the loud failure we want for a real regression (e.g. the FOR
      // UPDATE got removed from `regenerateRecoveryCodes`, so regen never
      // blocks).
      await waitUntilQueuedWaiters(lockTarget, 1);

      // While regen is blocked the row must still hold the original
      // batch verbatim — no partial write has been applied. A plain
      // SELECT (snapshot read) is not blocked by FOR UPDATE so this
      // observation is safe to make from the test connection.
      const midRow = await db.select().from(users).where(eq(users.id, userId));
      expect(midRow[0]?.totpRecoveryCodes).toEqual(oldHashes);

      // Release our lock; regen now proceeds.
      await blocker.query('COMMIT');
      blockerCommitted = true;

      const newCodes = await regenPromise;
      regenPromise = null; // already drained — finally must not redrain.
      expect(newCodes).not.toBeNull();
      expect(newCodes!).toHaveLength(10);

      const after = await db.select().from(users).where(eq(users.id, userId));
      const finalHashes = after[0]!.totpRecoveryCodes ?? [];
      expect(finalHashes).toHaveLength(10);
      // No old hash survives the regenerate.
      for (const h of finalHashes) {
        expect(oldHashes).not.toContain(h);
      }
      // Every new plaintext code matches exactly one stored hash —
      // the regenerated batch is internally consistent.
      for (const c of newCodes!) {
        const stripped = c.replace('-', '');
        // eslint-disable-next-line no-await-in-loop
        const matches = await Promise.all(
          finalHashes.map((h) => verifyPassword(stripped, h)),
        );
        expect(matches.filter(Boolean)).toHaveLength(1);
      }
      // And the previously-issued recovery codes are now dead — a
      // regression that resurrected them would fail this check.
      expect((await totpService.verifyLoginCode(userId, oldBatch[0])).ok).toBe(false);
      expect((await totpService.verifyLoginCode(userId, oldBatch[1])).ok).toBe(false);
    } finally {
      // Order matters: release the lock first (so a still-pending
      // regen can drain), THEN await regen to settle, THEN release
      // the connection. Without the drain step a poll-timeout or
      // mid-test assertion failure would leave a background
      // regenerate landing AFTER the test returns, corrupting the
      // next test's expectations.
      if (!blockerCommitted) {
        await blocker.query('ROLLBACK').catch(() => {});
      }
      if (regenPromise) {
        await regenPromise.catch(() => {});
      }
      blocker.release();
    }
  });

  // Task #130: explicit both-orderings race coverage. The blocker test
  // above proves regenerate uses FOR UPDATE; these tests prove that
  // when verify and regenerate are forced to serialize against each
  // OTHER (not against an external blocker), the lock prevents either
  // schedule from resurrecting old hashes.
  //
  // Strategy: hold a sentinel FOR UPDATE lock on the user row, then
  // queue the two operations one at a time, polling pg_locks (scoped to
  // this row) between each so the SECOND op only fires after the FIRST is
  // observed to have queued behind the sentinel (see
  // waitUntilQueuedWaiters above). In this controlled scenario
  // Postgres services the queued waiters in arrival order, so the
  // order in which we kick the operations off becomes the
  // deterministic order in which they commit once the sentinel is
  // released. No reliance on which Promise "happens to win" — every
  // run exercises the exact ordering named in the test.
  for (const order of ['verify-first', 'regenerate-first'] as const) {
    it(
      `Task #130: serializes verify+regenerate deterministically (${order}) — old hashes never resurrect`,
      { timeout: 30_000 },
      async () => {
        // Seed a fresh, known recovery batch so verify has a real
        // plaintext code to attempt against the OLD hashes.
        const oldBatch = (await totpService.verifyAndEnable(
          userId,
          currentCode(secretBase32),
        ))!;
        expect(oldBatch.length).toBeGreaterThanOrEqual(2);
        const beforeRow = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const oldHashes = beforeRow[0]!.totpRecoveryCodes ?? [];
        expect(oldHashes.length).toBeGreaterThan(0);
        const targetOldCode = oldBatch[0];

        // Pool capacity must be >= 3 (sentinel + verify + regen). The
        // app pool is sized well above that; if it ever shrinks, this
        // test will time out at the lock-wait poll — caller-visible
        // failure, not a silent skip.
        const blocker = await pool.connect();
        let blockerCommitted = false;
        let verifyPromise: Promise<TotpLoginResult> | null = null;
        let regenPromise: Promise<string[] | null> | null = null;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT id FROM users WHERE id = $1 FOR UPDATE',
            [userId],
          );
          // Sentinel holds the row lock. Capture its lock identity so the
          // wait polls below are scoped to THIS row and concurrent test
          // files sharing the DB can't make a poll return early (see
          // waitUntilQueuedWaiters).
          const lockTarget = await getSentinelLockTarget(blocker, userId);

          const fireVerify = (): Promise<TotpLoginResult> => {
            const p = totpService.verifyLoginCode(userId, targetOldCode);
            // Silence unhandled-rejection bookkeeping during the poll.
            // The real outcome is awaited (and asserted) below; the
            // finally drains it on every error path.
            p.catch(() => {});
            return p;
          };
          const fireRegen = (): Promise<string[] | null> => {
            const p = totpService.regenerateRecoveryCodes(
              userId,
              currentCode(secretBase32),
            );
            p.catch(() => {});
            return p;
          };

          if (order === 'verify-first') {
            verifyPromise = fireVerify();
            await waitUntilQueuedWaiters(lockTarget, 1);
            regenPromise = fireRegen();
            await waitUntilQueuedWaiters(lockTarget, 2);
          } else {
            regenPromise = fireRegen();
            await waitUntilQueuedWaiters(lockTarget, 1);
            verifyPromise = fireVerify();
            await waitUntilQueuedWaiters(lockTarget, 2);
          }

          // Release the sentinel; queued waiters drain in FIFO order.
          await blocker.query('COMMIT');
          blockerCommitted = true;

          const verifyResult = await verifyPromise;
          verifyPromise = null;
          const regenResult = await regenPromise;
          regenPromise = null;

          // Regenerate always succeeds — TOTP code was valid and there
          // is no precondition on the old batch contents.
          expect(regenResult).not.toBeNull();
          expect(regenResult!).toHaveLength(10);

          if (order === 'verify-first') {
            // Verify saw the OLD batch, found the target code, consumed
            // it, and committed BEFORE regenerate replaced the batch.
            // Exactly the dangerous path: the lock must guarantee that
            // verify's "remaining = old minus consumed" write does NOT
            // land after regenerate's commit.
            expect(verifyResult.ok).toBe(true);
            if (verifyResult.ok) {
              expect(verifyResult.factor).toBe('recovery');
            }
          } else {
            // Verify ran AFTER regenerate replaced the batch and
            // re-read inside its own transaction → the old plaintext
            // code is no longer present in the new batch → fails.
            expect(verifyResult.ok).toBe(false);
          }

          // In every ordering: the final on-disk batch contains the
          // 10 NEW hashes and NONE of the old ones — proof that
          // regenerate's write was not clobbered by verify's
          // consume-and-write computed against a stale snapshot.
          const after = await db
            .select()
            .from(users)
            .where(eq(users.id, userId));
          const finalHashes = after[0]!.totpRecoveryCodes ?? [];
          expect(finalHashes).toHaveLength(10);
          for (const h of finalHashes) {
            expect(oldHashes).not.toContain(h);
          }

          // Each new plaintext code matches exactly one stored hash —
          // the regenerated batch is internally consistent.
          for (const c of regenResult!) {
            const stripped = c.replace('-', '');
            // eslint-disable-next-line no-await-in-loop
            const matches = await Promise.all(
              finalHashes.map((h) => verifyPassword(stripped, h)),
            );
            expect(matches.filter(Boolean)).toHaveLength(1);
          }

          // New codes verify EXACTLY ONCE through the public service
          // API: a fresh code from the regenerated batch succeeds the
          // first time it's presented to verifyLoginCode and is then
          // consumed (removed from the on-disk batch), so a second
          // attempt with the same plaintext returns ok:false. Proving
          // this through the service — not just via offline
          // verifyPassword on the raw hashes — closes the loop end to
          // end (a regression in the consume-after-match step would be
          // invisible to the offline-hash check above).
          const oneShotCode = regenResult![1];
          const firstAttempt = await totpService.verifyLoginCode(
            userId,
            oneShotCode,
          );
          expect(firstAttempt.ok).toBe(true);
          if (firstAttempt.ok) {
            expect(firstAttempt.factor).toBe('recovery');
          }
          const secondAttempt = await totpService.verifyLoginCode(
            userId,
            oneShotCode,
          );
          expect(secondAttempt.ok).toBe(false);

          // No code from the old batch can verify against the new
          // batch — even the one verify-first consumed. This is the
          // user-visible invariant: once regenerate commits, every
          // previously-issued recovery code is dead.
          for (const oldCode of oldBatch) {
            // eslint-disable-next-line no-await-in-loop
            expect(
              (await totpService.verifyLoginCode(userId, oldCode)).ok,
            ).toBe(false);
          }

          // "Exactly one of (verify, regenerate) had a LASTING write
          // effect on the recovery_codes column" — derived from the
          // observable invariants above, not asserted via a constant:
          //
          //   (a) regenerate's effect persists: every new plaintext
          //       in `regenResult` matches exactly one hash in
          //       `finalHashes` (proven by the per-code Promise.all
          //       check above) AND `finalHashes` has length 10 (the
          //       full new batch landed).
          //   (b) verify's effect does NOT persist: in BOTH orderings
          //       no old hash survives in `finalHashes` (proven by
          //       the !oldHashes.contains loop above) AND every old
          //       plaintext returns ok:false from verifyLoginCode
          //       (the loop just above this block). In verify-first
          //       this is the LOCK doing its job — verify's
          //       consume-and-rewrite was atomically overwritten by
          //       regenerate's batch replacement; in regenerate-first
          //       verify never wrote anything (it ran on the new
          //       batch with an old code → ok:false).
          //
          // Without the lock, verify's stale-snapshot write could
          // land AFTER regenerate's commit in verify-first ordering
          // and resurrect the old batch (a hash from oldHashes would
          // appear in finalHashes, or an oldBatch plaintext would
          // verify ok:true) — both observable failure modes the
          // assertions above would catch.
        } finally {
          // Order matters: release the sentinel first (so any still-
          // pending op can drain), THEN await both ops to settle, THEN
          // release the connection. Without the drain, a poll-timeout
          // or mid-test assertion failure could leave a background
          // operation landing AFTER the test returns and corrupting
          // the next test's expectations.
          if (!blockerCommitted) {
            await blocker.query('ROLLBACK').catch(() => {});
          }
          if (verifyPromise) await verifyPromise.catch(() => {});
          if (regenPromise) await regenPromise.catch(() => {});
          blocker.release();
        }
      },
    );
  }

  it('throttles with 429 after 10 failed attempts from the same IP (Task #129)', { timeout: 30000 }, async () => {
    const cookie = await login();
    const ATTACKER_IP = '198.51.100.7';
    // Reset both buckets so prior tests / unique-IP traffic in this
    // file don't poison the per-account counter.
    totpRecoveryRegenerateIpLimiter.resetKey(`ip:${ATTACKER_IP}`);
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);

    // 10 failed attempts (wrong password) all return 401 — the budget
    // for this IP is exactly 10, matching authLimiter / totpVerifyLimiter.
    // We reset the per-account password-lockout state between attempts
    // so the unrelated lockout-after-5-failures defense doesn't flip
    // the response code from 401 to a different failure shape mid-loop.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // 11th attempt from the same IP is throttled — the limiter runs
    // before the route handler, so even a correct password+code combo
    // would be blocked here.
    await resetAccountLockout();
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      ATTACKER_IP,
    );
    expect(blocked.status).toBe(429);

    // Confirm the DB wasn't touched while throttled.
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(after[0]?.totpRecoveryCodes).toEqual(['$argon2id$placeholder']);
  });

  it('throttle bucket clears after a successful regenerate (Task #129)', { timeout: 30000 }, async () => {
    const cookie = await login();
    const ATTACKER_IP = '198.51.100.42';
    // Start from a clean bucket so this test is independent of others.
    totpRecoveryRegenerateIpLimiter.resetKey(`ip:${ATTACKER_IP}`);
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);

    // Burn 9 of the 10 attempts on bad passwords.
    for (let i = 0; i < 9; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // One successful regenerate. The route calls resetKey() on success,
    // which fully clears both the per-IP and per-account buckets.
    await resetAccountLockout();
    const ok = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      ATTACKER_IP,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    // After the success, we should be able to make a fresh batch of
    // 10 failed attempts without ever hitting 429 — proof the bucket
    // was cleared, not just decremented by one.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ATTACKER_IP,
      );
      expect(r.status).toBe(401);
    }

    // And the 11th still throttles — the limiter is still functional,
    // it just got reset by the prior success.
    await resetAccountLockout();
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      ATTACKER_IP,
    );
    expect(blocked.status).toBe(429);
  });

  it('throttles per-account even when failed attempts come from many IPs (Task #129)', { timeout: 30000 }, async () => {
    const cookie = await login();
    // Reset the per-account bucket so prior tests don't interfere.
    totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${userId}`);

    // 10 failed attempts spread across 10 different IPs. The per-IP
    // limiter never trips (each IP is at 1/10), but the per-account
    // limiter sees all 10 hits against the same userId.
    for (let i = 0; i < 10; i++) {
      await resetAccountLockout();
      const ip = `203.0.113.${i + 1}`;
      totpRecoveryRegenerateIpLimiter.resetKey(`ip:${ip}`);
      const r = await jsonReq(
        `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
        'POST',
        { password: 'definitely-not-the-password', code: currentCode(secretBase32) },
        cookie,
        ip,
      );
      expect(r.status).toBe(401);
    }

    // 11th attempt from yet another fresh IP is blocked by the
    // per-account limiter even though that IP has never hit this
    // endpoint before.
    await resetAccountLockout();
    const freshIp = '203.0.113.250';
    totpRecoveryRegenerateIpLimiter.resetKey(`ip:${freshIp}`);
    const blocked = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
      freshIp,
    );
    expect(blocked.status).toBe(429);
  });

  it('sanity: secret and password column not exposed in the response', async () => {
    const cookie = await login();
    const r = await jsonReq(
      `${baseUrl}/api/auth/totp/recovery-codes/regenerate`,
      'POST',
      { password: PWD, code: currentCode(secretBase32) },
      cookie,
    );
    expect(r.status).toBe(200);
    const keys = Object.keys(r.body);
    expect(keys.sort()).toEqual(['recoveryCodes', 'success']);
    // Defensive: confirm the encrypted secret in the DB hasn't been
    // touched (we only rotated codes, not the secret).
    const after = await db.select().from(users).where(eq(users.id, userId));
    expect(decryptTotpSecret(after[0]!.totpSecretEncrypted!)).toBe(secretBase32);
  });
});
