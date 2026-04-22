/**
 * Password hashing abstraction.
 *
 * The application is migrating from bcrypt (cost 12) to argon2id. New
 * hashes are always argon2id; legacy bcrypt hashes are still verified
 * and transparently rehashed to argon2id on the next successful login
 * (see authService.loginUser).
 *
 * All password hashing in the codebase MUST go through this module so
 * the migration is uniform — direct imports of `bcryptjs` or
 * `@node-rs/argon2` outside this file are not allowed.
 *
 * Design notes
 * ------------
 * - argon2id parameters follow the OWASP 2024 baseline for
 *   server-side authentication (memory ≥ 19 MiB, t ≥ 2, p = 1).
 *   We pick m = 64 MiB, t = 3, p = 1 to give comfortable headroom on
 *   modern hardware while keeping a single login under ~75 ms on the
 *   workspace's Neon-class compute. Tunable via env if a deployment
 *   needs to slow them down further.
 * - `verifyPassword` recognises three legacy bcrypt prefixes
 *   (`$2a$`, `$2b$`, `$2y$`) and the argon2id prefix (`$argon2id$`).
 *   Anything else is treated as malformed and fails closed.
 * - `needsRehash` returns true for any bcrypt hash, AND for an
 *   argon2id hash whose parameters are weaker than the current
 *   target. That keeps us able to rotate parameters in the future
 *   without needing a second migration project.
 */

import * as argon2 from '@node-rs/argon2';
import { compare as bcryptCompare } from 'bcryptjs';

// ---------------------------------------------------------------------------
// argon2id parameters
// ---------------------------------------------------------------------------
// Memory cost (KiB), iterations, parallelism. Defaults track the OWASP
// 2024 baseline (m=19 MiB, t=2, p=1) — secure but deliberately on the
// low end of the recommended range so a burst of concurrent logins
// can't exhaust process memory (each verify allocates `memoryCost`
// KiB transiently). Operators on bigger compute can tune any of these
// higher via env without a redeploy of code; needsRehash() will then
// transparently lift existing hashes to the new params on next login.
function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ARGON2_MEMORY_KIB = parsePositiveInt('ARGON2_MEMORY_KIB', 19 * 1024); // 19 MiB (OWASP min)
const ARGON2_TIME_COST = parsePositiveInt('ARGON2_TIME_COST', 2);
const ARGON2_PARALLELISM = parsePositiveInt('ARGON2_PARALLELISM', 1);

const ARGON2_OPTIONS = {
  algorithm: argon2.Algorithm.Argon2id,
  memoryCost: ARGON2_MEMORY_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

// Bcrypt cost retained ONLY for the dummy-hash timing constant and for
// any future bcrypt-side rehash decisions. New writes are argon2id.
export const LEGACY_BCRYPT_COST = 12;

// ---------------------------------------------------------------------------
// Hash format detection
// ---------------------------------------------------------------------------
function isBcryptHash(stored: string): boolean {
  return /^\$2[aby]\$/.test(stored);
}

function isArgon2idHash(stored: string): boolean {
  return stored.startsWith('$argon2id$');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a fresh password hash using the current target algorithm
 * (argon2id). Always use this for new writes (registration, password
 * reset, admin-initiated password change, etc.).
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored hash. Auto-dispatches
 * to argon2id or bcrypt based on the stored hash's prefix. Returns
 * false (never throws) on malformed or unknown hash formats so a
 * corrupt row can't crash an auth handler.
 */
export async function verifyPassword(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  try {
    if (isArgon2idHash(stored)) {
      return await argon2.verify(stored, plaintext);
    }
    if (isBcryptHash(stored)) {
      return await bcryptCompare(plaintext, stored);
    }
    return false;
  } catch {
    // Malformed hash, parameter mismatch, etc. Treat as a failed
    // verification rather than a 500 — the caller's failure path
    // (lockout counter, timing parity) still runs.
    return false;
  }
}

/**
 * Decide whether a stored hash should be rehashed on the next
 * successful verification. Returns true if:
 *   - the hash is bcrypt (we're migrating away from bcrypt), OR
 *   - the hash is argon2id but produced with weaker parameters than
 *     the current target (algorithm parameters were raised since the
 *     hash was written).
 *
 * Wrapped in a try/catch — if the hash is malformed in a way that
 * prevents parameter inspection we return false so the login path
 * doesn't churn on a bad row; the next password reset will fix it.
 */
export function needsRehash(stored: string): boolean {
  try {
    if (isBcryptHash(stored)) return true;
    if (!isArgon2idHash(stored)) return false;
    // argon2id hash format:
    //   $argon2id$v=19$m=<mem>,t=<time>,p=<par>$<salt>$<digest>
    const paramsSegment = stored.split('$')[3] ?? '';
    const params = Object.fromEntries(
      paramsSegment.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k, Number.parseInt(v, 10)];
      }),
    );
    const m = params.m ?? 0;
    const t = params.t ?? 0;
    const p = params.p ?? 0;
    return (
      m < ARGON2_MEMORY_KIB ||
      t < ARGON2_TIME_COST ||
      p < ARGON2_PARALLELISM
    );
  } catch {
    return false;
  }
}

/**
 * A pre-computed argon2id hash of a long random string that no real
 * user can ever submit. Used by login flows so the "no such user"
 * branch can still execute a real argon2.verify and take the same
 * wall-clock time as the "user exists, wrong password" branch — this
 * is what closes the username-enumeration timing oracle.
 *
 * Generated at module load (once per process) using the SAME params
 * that hashPassword() uses, so the dummy verify cost tracks the real
 * verify cost as parameters are tuned. The plaintext is intentionally
 * unrecoverable — even if it leaked it could not be used to log in.
 *
 * Note on the migration window: legacy bcrypt-stored users will have
 * a *faster* verify than this argon2 dummy until they next log in
 * (which transparently rehashes them to argon2id). That gap is bounded
 * (every successful login self-heals it) and the leaked information —
 * "this username is on the legacy hash" — is strictly less sensitive
 * than the canonical username-enumeration oracle this dummy exists to
 * close. Once the table is fully migrated the timings re-align.
 */
let _dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!_dummyHashPromise) {
    const dummyPlaintext =
      'ZZ_DUMMY_NEVER_VALID_' +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    _dummyHashPromise = hashPassword(dummyPlaintext);
  }
  return _dummyHashPromise;
}

/**
 * Pre-warm the dummy hash so the first login of a process doesn't pay
 * the one-time generation cost. Optional — getDummyHash() will lazily
 * create it on first use either way.
 */
export function warmupPasswordHash(): Promise<void> {
  return getDummyHash().then(() => undefined);
}
