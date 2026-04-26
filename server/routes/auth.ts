/**
 * Authentication Routes
 *
 * Provides endpoints for login, logout, and user management.
 *
 * Error handling: handlers throw typed `AppError` subclasses
 * (`ValidationError`, `UnauthorizedError`, `ConflictError`, `NotFoundError`,
 * etc.) and rely on the router-level error middleware at the bottom of this
 * file (which delegates to `toSafeErrorResponse`) to map them to the right
 * HTTP status and a sanitized JSON body. Don't call `res.status(N).json(...)`
 * directly for error paths — see `server/errors.ts` for the convention.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authService, getUserCacheStats } from '../services/authService';
import { totpService } from '../services/totpService';
import { createSafeUser, createSafeUserAsync, requireAuth, requireAdmin } from '../middleware/auth';
import { z } from 'zod';
import {
  adminCreateUserSchema,
  adminUpdateUserEmailSchema,
  confirmRecoveryEmailSchema,
  selfProposeRecoveryEmailSchema,
  strongPasswordSchema,
  REQUIRE_ADMIN_2FA_SETTING_KEY,
  requireAdminTwoFactorSettingsSchema,
} from '../../shared/schema';
import { pgStorage } from '../pgStorage';
import {
  AppError,
  AuthError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  sendError,
  toSafeErrorResponse,
} from '../errors';
import { ipKeyGenerator } from 'express-rate-limit';
import {
  authLimiter,
  emailVerificationConfirmLimiter,
  emailVerificationRequestLimiter,
  passwordResetRequestLimiter,
  totpRecoveryRegenerateAccountLimiter,
  totpRecoveryRegenerateIpLimiter,
  totpVerifyLimiter,
} from '../middleware/rateLimiter';
import { SESSION_COOKIE_NAME } from '../sessionConfig';
import { revokeAllSessionsForUser } from '../session';
import { logger, errorContext } from '../logger';

// Validation schemas
//
// Login intentionally accepts any non-empty password up to a sane upper
// bound. The strong-password policy applies to *creating or changing* a
// password (registration, reset), not to logging in with an existing one,
// so legacy accounts with shorter passwords can still sign in and then
// rotate their password.
const loginSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(1).max(128)
});

// Step 1: request a reset link. usernameOrEmail is whatever the user types
// in the form — we accept either the account's username or its email.
const requestResetSchema = z.object({
  usernameOrEmail: z.string().min(1).max(254),
});

// Step 2: complete the reset. The token is the raw value delivered in the
// recovery email; the server hashes it and matches against the stored
// SHA-256. The new password must satisfy the strong-password policy.
const completeResetSchema = z.object({
  token: z.string().min(1).max(256),
  newPassword: strongPasswordSchema,
});

// Generic message returned by /request-reset regardless of whether the
// account exists. This is the anti-enumeration guarantee: an attacker
// cannot learn whether a username/email is registered.
const RESET_REQUEST_GENERIC_MESSAGE =
  'If an account matching that username or email exists and has a recovery email on file, ' +
  'a password reset link has been sent. Check your inbox (and spam folder) within a few minutes.';

/**
 * Throw a `ValidationError` carrying the zod issue tree. Keeps the
 * pre-existing client-facing shape (`{ error: 'Invalid input', details: ... }`)
 * because the sanitizer now forwards `details` for any AppError that has it.
 */
function throwOnInvalidInput(parsed: z.SafeParseReturnType<unknown, unknown>) {
  if (!parsed.success) {
    throw new ValidationError('Invalid input', parsed.error.format());
  }
}

export function createAuthRouter(): Router {
  const router = Router();

  // Current user endpoint
  router.get('/me', async (req: Request & { session?: any }, res: Response, next: NextFunction) => {
    try {
      if (!req.session || !req.session.userId) {
        return res.json(null);
      }

      const user = await authService.getUserById(req.session.userId);

      if (!user) {
        // The session refers to a user that no longer exists (deleted /
        // hard-disabled). Fully destroy the session row in the store
        // rather than just blanking userId — leaving an authenticated
        // session-id alive in the store keeps a stale credential around
        // that could be reused if the underlying user record is ever
        // re-created with the same id, and accumulates orphan rows.
        await new Promise<void>((resolve) => {
          req.session.destroy(() => resolve());
        });
        // Clear the cookie on the client too so the browser stops
        // presenting the now-dead session id on subsequent requests.
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        return res.json(null);
      }

      res.json(await createSafeUserAsync(user));
    } catch (error) {
      logger.error('auth.me.error', errorContext(error));
      next(error);
    }
  });

  router.post('/login', authLimiter, async (req: Request & { session?: any }, res: Response, next: NextFunction) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      throwOnInvalidInput(parsed);
      const { username, password } = parsed.data!;

      const user = await authService.loginUser(username, password);

      if (!user) {
        logger.info('auth.login.failed');
        throw new UnauthorizedError('Invalid username or password');
      }

      // Ensure session exists
      if (!req.session) {
        logger.error('auth.login.no_session');
        throw new Error('Session initialization failed');
      }

      // Two-factor gate. If the account has TOTP enabled, do NOT issue
      // an authenticated session yet — instead stash the candidate user
      // id on the session and tell the client to collect a code. The
      // pending state expires after PENDING_TOTP_TTL_MS so an
      // attacker who steals a half-completed login session can't sit
      // on it indefinitely.
      if (user.totpEnabled) {
        try {
          await new Promise<void>((resolve, reject) => {
            req.session.regenerate((err: Error | null) =>
              err ? reject(err) : resolve(),
            );
          });
        } catch (regenErr) {
          logger.error('auth.login.session_regen_failed_totp', errorContext(regenErr));
          throw new Error('Session initialization failed');
        }
        req.session.pendingTotpUserId = user.id;
        req.session.pendingTotpIssuedAt = Date.now();
        await new Promise<void>((resolve, reject) => {
          req.session.save((err: Error | null) =>
            err ? reject(err) : resolve(),
          );
        });
        return res.json({ success: true, requiresTotp: true });
      }

      // Regenerate session ID to prevent session fixation. Any pre-login
      // session value (and its server-side row) is discarded; a brand-new
      // session ID is issued before any authenticated state is attached.
      try {
        await new Promise<void>((resolve, reject) => {
          req.session.regenerate((err: Error | null) => {
            if (err) reject(err); else resolve();
          });
        });
      } catch (regenErr) {
        logger.error('auth.login.session_regen_failed', errorContext(regenErr));
        throw new Error('Session initialization failed');
      }

      // Populate the fresh session with authenticated user info.
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      // Stamp the session-creation time so the absolute-max-age
      // enforcement middleware in server/index.ts can expire
      // long-lived sessions even when the user keeps them active
      // (rolling sessions reset the cookie expiry on every request).
      req.session.createdAt = Date.now();

      logger.info('auth.login.ok');

      // Persist the new session before responding.
      try {
        await new Promise<void>((resolve, reject) => {
          req.session.save((err: Error | null) => {
            if (err) reject(err); else resolve();
          });
        });
      } catch (saveErr) {
        logger.error('auth.login.session_save_failed', errorContext(saveErr));
        // Tear down the partially-populated session so no half-authenticated
        // state can leak to the client.
        await new Promise<void>((resolve) => {
          req.session.destroy(() => resolve());
        });
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        throw new Error('Session initialization failed');
      }

      logger.info('auth.login.session_saved');

      res.json({
        success: true,
        user: await createSafeUserAsync(user),
      });
    } catch (error) {
      logger.error('auth.login.error', errorContext(error));
      next(error);
    }
  });

  // ---------------------------------------------------------------------
  // Two-factor authentication (TOTP) — Task #56
  // ---------------------------------------------------------------------
  //
  // Login flow:
  //   POST /api/auth/login                     — username + password
  //     -> { success: true, requiresTotp: true } if the account has TOTP
  //        on; the response cookie now identifies a *pending* session
  //        (no userId set yet). Otherwise the response is the existing
  //        fully-authenticated payload.
  //   POST /api/auth/totp/verify { code }      — finishes the pending
  //        login by validating a 6-digit TOTP or a one-time recovery
  //        code, regenerating the session, and attaching the user.
  //
  // Enrollment flow (under requireAuth, self-service):
  //   GET  /api/auth/totp/status               — { enabled, pending,
  //        recoveryCodesRemaining }
  //   POST /api/auth/totp/enroll               — generates secret,
  //        returns otpauth URL for QR rendering.
  //   POST /api/auth/totp/enroll/verify { code } — confirms first code,
  //        flips totpEnabled, returns the one-time recovery codes.
  //   POST /api/auth/totp/disable { password } — turns 2FA off after a
  //        password re-check (defense in depth against a momentarily
  //        unattended browser).

  // Pending TOTP-login state expires after this. Long enough that a
  // user can fish out their phone, short enough that a stolen
  // pending-cookie can't be parked indefinitely waiting for the
  // attacker to phish the second factor.
  const PENDING_TOTP_TTL_MS = 5 * 60 * 1000;

  const totpVerifySchema = z.object({
    // Accept either a 6-digit TOTP or a formatted recovery code
    // (XXXXX-XXXXX). Server normalises spacing/dashes/case.
    code: z.string().min(6).max(32),
  });

  router.post(
    '/totp/verify',
    totpVerifyLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.session || !req.session.pendingTotpUserId) {
          throw new UnauthorizedError('No pending login. Please sign in again.');
        }
        const issued = req.session.pendingTotpIssuedAt ?? 0;
        if (Date.now() - issued > PENDING_TOTP_TTL_MS) {
          // Drop the stale pending state so the next /login request
          // starts from a clean session.
          req.session.pendingTotpUserId = undefined;
          req.session.pendingTotpIssuedAt = undefined;
          await new Promise<void>((resolve) =>
            req.session.save(() => resolve()),
          );
          throw new UnauthorizedError(
            'Login attempt expired. Please sign in again.',
          );
        }

        const parsed = totpVerifySchema.safeParse(req.body);
        throwOnInvalidInput(parsed);
        const candidateId = req.session.pendingTotpUserId;

        // Per-pending-session failure counter (Task #102). Surfaces in
        // the audit line so an operator grepping login_failure can see
        // when one stuck pending cookie is being hammered. Reset on
        // success below; the pending state is also cleared on TTL
        // expiry / re-login so the counter cannot persist past the
        // pending window.
        const priorAttempts = req.session.totpFailedAttempts ?? 0;
        const ctx = {
          requestId: (req as any).requestId as string | undefined,
          ip: req.ip,
          attemptCount: priorAttempts + 1,
        };
        const result = await totpService.verifyLoginCode(
          candidateId,
          parsed.data!.code,
          ctx,
        );
        if (!result.ok) {
          req.session.totpFailedAttempts = priorAttempts + 1;
          throw new UnauthorizedError('Invalid verification code');
        }
        req.session.totpFailedAttempts = undefined;

        const user = await authService.getUserById(candidateId);
        if (!user) {
          throw new UnauthorizedError('Account no longer exists');
        }

        // Promote the pending session to a fully authenticated one.
        // Regenerate again so the cookie issued to a passive observer
        // of the password step cannot be reused post-2FA.
        try {
          await new Promise<void>((resolve, reject) => {
            req.session.regenerate((err: Error | null) =>
              err ? reject(err) : resolve(),
            );
          });
        } catch (regenErr) {
          logger.error('auth.totpVerify.session_regen_failed', errorContext(regenErr));
          throw new Error('Session initialization failed');
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.createdAt = Date.now();
        req.session.pendingTotpUserId = undefined;
        req.session.pendingTotpIssuedAt = undefined;

        try {
          await new Promise<void>((resolve, reject) => {
            req.session.save((err: Error | null) =>
              err ? reject(err) : resolve(),
            );
          });
        } catch (saveErr) {
          logger.error('auth.totpVerify.session_save_failed', errorContext(saveErr));
          await new Promise<void>((resolve) =>
            req.session.destroy(() => resolve()),
          );
          res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
          throw new Error('Session initialization failed');
        }

        res.json({ success: true, user: await createSafeUserAsync(user) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/totp/status',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const status = await totpService.getStatus(req.user!.id);
        res.json(status);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/totp/enroll',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await totpService.beginEnrollment(req.user!, {
          requestId: (req as any).requestId,
          ip: req.ip,
        });
        res.json(result);
      } catch (error) {
        logger.error('auth.totpEnroll.error', errorContext(error));
        next(error);
      }
    },
  );

  router.post(
    '/totp/enroll/verify',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = totpVerifySchema.safeParse(req.body);
        throwOnInvalidInput(parsed);
        const codes = await totpService.verifyAndEnable(
          req.user!.id,
          parsed.data!.code,
          { requestId: (req as any).requestId, ip: req.ip },
        );
        if (!codes) {
          throw new ValidationError(
            'That code did not match. Make sure your device clock is correct and try the next code.',
          );
        }
        res.json({ success: true, recoveryCodes: codes });
      } catch (error) {
        next(error);
      }
    },
  );

  const disableTotpSchema = z.object({
    // Re-check the current password so a momentarily unattended
    // browser cannot silently turn 2FA off.
    password: z.string().min(1).max(128),
  });

  // Regenerate the recovery code batch for a user who's already
  // enrolled (Task #101). Two gates: their current password (so a
  // momentarily-unattended browser can't silently rotate the codes)
  // AND a current authenticator code (so a stolen session without the
  // physical second factor can't either). On success we return the new
  // codes once — they are NOT recoverable later.
  const regenerateRecoveryCodesSchema = z.object({
    password: z.string().min(1).max(128),
    code: z.string().min(1).max(20),
  });

  router.post(
    '/totp/recovery-codes/regenerate',
    requireAuth,
    // Per-IP and per-account throttling (Task #129). Mirrors the
    // login/TOTP-verify shape (10 attempts / 15 min). Both buckets
    // skip successful requests; on confirmed success we additionally
    // call resetKey() so a legitimate rotation fully clears the bucket
    // for both keys.
    totpRecoveryRegenerateIpLimiter,
    totpRecoveryRegenerateAccountLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = regenerateRecoveryCodesSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);
        const verified = await authService.loginUser(
          req.user!.username,
          parsed.data!.password,
        );
        if (!verified || verified.id !== req.user!.id) {
          throw new UnauthorizedError('Password did not match');
        }
        const codes = await totpService.regenerateRecoveryCodes(
          req.user!.id,
          parsed.data!.code,
          { requestId: (req as any).requestId, ip: req.ip },
        );
        if (!codes) {
          throw new ValidationError(
            'That authenticator code did not match. Make sure your device clock is correct and try the next code.',
          );
        }
        // Clear both throttle buckets so a successful rotation fully
        // resets the next-15-minute window for this IP and account.
        // skipSuccessfulRequests already prevents this hit from being
        // counted; resetKey additionally undoes any prior failures.
        try {
          // Reset key MUST be derived through ipKeyGenerator() to match
          // the bucket key the limiter actually wrote — for IPv6
          // clients the limiter normalizes to /64, so a raw req.ip
          // here would miss the active bucket and the reset would be
          // a no-op.
          totpRecoveryRegenerateIpLimiter.resetKey(
            `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
          );
          totpRecoveryRegenerateAccountLimiter.resetKey(`acct:${req.user!.id}`);
        } catch (resetErr) {
          // Reset is best-effort; never fail a successful rotation
          // because the limiter store hiccupped.
          logger.warn('auth.totpRegenerate.reset_key_failed', errorContext(resetErr));
        }
        res.json({ success: true, recoveryCodes: codes });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/totp/disable',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = disableTotpSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);
        const verified = await authService.loginUser(
          req.user!.username,
          parsed.data!.password,
        );
        if (!verified || verified.id !== req.user!.id) {
          throw new UnauthorizedError('Password did not match');
        }
        await totpService.disable(req.user!.id, {
          requestId: (req as any).requestId,
          ip: req.ip,
          actorRole: 'self',
        });
        res.json({ success: true });
      } catch (error) {
        next(error);
      }
    },
  );

  // Step 1 of the email-verified password reset flow. Always returns a
  // generic 200 so the endpoint cannot be used to enumerate accounts.
  // Rate-limited at 3 requests per IP per hour to prevent abuse of the
  // outbound email channel.
  router.post(
    '/request-reset',
    passwordResetRequestLimiter,
    async (req: Request, res: Response) => {
      const validation = requestResetSchema.safeParse(req.body);

      // Resolve the link base URL up front. In production we require an
      // operator-configured APP_BASE_URL — never trust the Host header,
      // which would otherwise let an attacker forge the link domain in
      // the recovery email by sending a poisoned Host header. In dev
      // (NODE_ENV !== 'production') we fall back to the request host so
      // the flow works out of the box on localhost / preview URLs.
      let baseUrl = process.env.APP_BASE_URL;
      if (!baseUrl) {
        if (process.env.NODE_ENV === 'production') {
          logger.error('auth.requestReset.missing_app_base_url');
          // Still return the generic message so the failure path is not
          // an enumeration oracle. The user-facing effect is "no email
          // arrives" — an operator alarm should fire on the log line.
          baseUrl = '';
        } else {
          baseUrl = `${req.protocol}://${req.get('host')}`;
        }
      }

      // Fire-and-forget the actual work so the HTTP response timing is
      // effectively constant regardless of whether the account exists,
      // whether we have an email on file, or how slow the email provider
      // is. Without this, a caller can distinguish "user exists" (extra
      // SELECT/UPDATE/INSERT + outbound HTTP) from "user does not exist"
      // (single SELECT) by wall-clock latency, which would re-introduce
      // the enumeration oracle that the generic response is meant to
      // close. setImmediate hands control back to the event loop before
      // any DB or network work begins.
      if (validation.success && baseUrl) {
        const identifier = validation.data.usernameOrEmail;
        setImmediate(() => {
          authService
            .requestPasswordReset(identifier, baseUrl as string)
            .catch((err) =>
              logger.error('auth.requestReset.error', errorContext(err)),
            );
        });
      }

      res.json({ message: RESET_REQUEST_GENERIC_MESSAGE });
    },
  );

  // Step 2 of the reset flow. Validates the token, marks it consumed,
  // and updates the password — atomically, so the same token can never
  // be redeemed twice. authLimiter is applied to slow brute-force token
  // guessing on top of the 256-bit token entropy.
  router.post(
    '/complete-reset',
    authLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = completeResetSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);

        const { token, newPassword } = parsed.data!;
        const success = await authService.completePasswordReset(
          token,
          newPassword,
        );

        if (!success) {
          throw new ValidationError(
            'This reset link is invalid or has expired. Please request a new one.',
          );
        }

        res.json({ success: true });
      } catch (error) {
        logger.error('auth.completeReset.error', errorContext(error));
        next(error);
      }
    },
  );

  // ---------------------------------------------------------------
  // Self-service recovery-email verification (Task #98)
  //
  // Lets a signed-in user attach a recovery email to their own
  // account without an admin in the loop. Two-step:
  //   POST /me/email/start-verification { email } → email link sent
  //   POST /me/email/confirm           { token } → email applied
  // GET /me/email/pending → "is there an outstanding verification?"
  //
  // The confirm endpoint is intentionally unauthenticated — the link
  // target is opened by whichever browser receives the email, which
  // may not have the user's session. Possession of a 256-bit token
  // delivered to the proposed inbox proves email control.
  // ---------------------------------------------------------------
  router.post(
    '/me/email/start-verification',
    requireAuth,
    emailVerificationRequestLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.session?.userId;
        if (!userId) {
          throw new UnauthorizedError('Not authenticated');
        }
        const parsed = selfProposeRecoveryEmailSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);

        // Same baseUrl resolution as the password-reset endpoint:
        // require APP_BASE_URL in production, fall back to the
        // request host in dev. Never trust the Host header in prod —
        // an attacker could otherwise forge the link domain in the
        // outbound email by sending a poisoned Host header.
        let baseUrl = process.env.APP_BASE_URL;
        if (!baseUrl) {
          if (process.env.NODE_ENV === 'production') {
            logger.error('auth.emailVerification.missing_app_base_url');
            throw new Error(
              'Email verification is not configured on this server.',
            );
          }
          baseUrl = `${req.protocol}://${req.get('host')}`;
        }

        await authService.requestEmailVerification(
          userId,
          parsed.data!.email,
          baseUrl,
        );
        res.json({
          success: true,
          message:
            'Verification link sent. Check your inbox and click the link to confirm.',
          pendingEmail: parsed.data!.email,
        });
      } catch (error) {
        logger.error(
          'auth.emailVerification.request_error',
          errorContext(error),
        );
        next(error);
      }
    },
  );

  router.post(
    '/me/email/confirm',
    emailVerificationConfirmLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = confirmRecoveryEmailSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);

        const result = await authService.confirmEmailVerification(
          parsed.data!.token,
        );
        if (!result) {
          throw new ValidationError(
            'This verification link is invalid or has expired. Please request a new one.',
          );
        }
        res.json({ success: true, email: result.email });
      } catch (error) {
        logger.error(
          'auth.emailVerification.confirm_error',
          errorContext(error),
        );
        next(error);
      }
    },
  );

  router.get(
    '/me/email/pending',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.session?.userId;
        if (!userId) {
          throw new UnauthorizedError('Not authenticated');
        }
        const status = await authService.hasPendingEmailVerification(userId);
        res.json(status);
      } catch (error) {
        logger.error(
          'auth.emailVerification.pending_error',
          errorContext(error),
        );
        next(error);
      }
    },
  );

  // Logout endpoint
  router.post('/logout', (req: Request & { session?: any }, res: Response) => {
    if (req.session) {
      logger.info('auth.logout.start');

      req.session.destroy((err: Error | null) => {
        if (err) {
          logger.error('auth.logout.destroy_failed', errorContext(err));
          // Inside a synchronous callback, no `next` available — use the
          // sanitizer directly so the response shape stays consistent.
          return sendError(res, new Error('Failed to logout'));
        }

        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        res.json({ success: true });
      });
    } else {
      logger.info('auth.logout.no_session');
      res.json({ success: true });
    }
  });

  // Register endpoint — admin-only. Creating the first admin happens
  // out-of-band via the bootstrap CLI script (see replit.md), never here.
  router.post('/register', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = adminCreateUserSchema.safeParse(req.body);
      throwOnInvalidInput(parsed);
      const { username, password, role, email } = parsed.data!;

      try {
        const user = await authService.registerUser(username, password, role, email);
        res.json({
          success: true,
          user: createSafeUser(user),
        });
      } catch (err) {
        // authService throws ConflictError for "already exists" cases now,
        // but legacy AuthError-with-"already exists"-message is kept as a
        // safety net. Both are converted to a ConflictError so the response
        // shape (status + code) is identical to every other conflict.
        if (err instanceof ConflictError) {
          throw err;
        }
        if (err instanceof AuthError && err.message.includes('already exists')) {
          throw new ConflictError('Username already exists');
        }
        throw err;
      }
    } catch (error) {
      logger.error('auth.register.error', errorContext(error));
      next(error);
    }
  });

  // ---------------------------------------------------------------------
  // Admin Security overview (Task #100)
  // ---------------------------------------------------------------------
  //
  // Three endpoints for the admin Security tab:
  //   GET  /admin/security/overview     — table of every account with
  //        2FA status, recovery codes remaining, last 2FA usage.
  //   GET  /admin/security/require-2fa  — current toggle value.
  //   PUT  /admin/security/require-2fa  — set the toggle. Audit-logged.
  //   POST /admin/security/users/:id/disable-totp — disable another
  //        admin's 2FA after the calling admin re-confirms their own
  //        password. Audit-logged. Cannot target self (the
  //        self-service /totp/disable endpoint exists for that).

  router.get(
    '/admin/security/overview',
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const rows = await authService.getAdminSecurityOverview();
        res.json(rows);
      } catch (error) {
        logger.error('auth.admin.security_overview_error', errorContext(error));
        next(error);
      }
    },
  );

  // Live snapshot of the in-process user-by-id cache (Task #113). The
  // service emits a once-a-minute summary line to the logs; this
  // endpoint surfaces the same numbers in-app so operators can see the
  // hit ratio without grepping logs.
  router.get(
    '/admin/diagnostics/user-cache',
    requireAuth,
    requireAdmin,
    (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(getUserCacheStats());
      } catch (error) {
        logger.error('auth.admin.user_cache_stats_error', errorContext(error));
        next(error);
      }
    },
  );

  router.get(
    '/admin/security/require-2fa',
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const setting = await pgStorage.getAppSetting(REQUIRE_ADMIN_2FA_SETTING_KEY);
        res.json({ enabled: Boolean(setting?.enabled) });
      } catch (error) {
        logger.error('auth.admin.require2fa_get_error', errorContext(error));
        next(error);
      }
    },
  );

  router.put(
    '/admin/security/require-2fa',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = requireAdminTwoFactorSettingsSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);
        const previous = await pgStorage.getAppSetting(REQUIRE_ADMIN_2FA_SETTING_KEY);
        // Setting + audit row commit together so an audit-write failure
        // can't leave a security toggle silently changed (Task #100).
        await pgStorage.setAppSettingWithAudit(
          REQUIRE_ADMIN_2FA_SETTING_KEY,
          parsed.data!,
          {
            actorUserId: req.user!.id,
            actorIp: req.ip ?? null,
            action: 'require_admin_2fa.set',
            targetUserId: null,
            metadata: {
              previous: Boolean(previous?.enabled),
              next: parsed.data!.enabled,
            },
          },
        );
        res.json({ enabled: parsed.data!.enabled });
      } catch (error) {
        logger.error('auth.admin.require2fa_set_error', errorContext(error));
        next(error);
      }
    },
  );

  const adminDisableTotpSchema = z.object({
    // Re-check the calling admin's own password before letting them
    // disable someone else's second factor — same defence-in-depth as
    // the self-service disable route.
    password: z.string().min(1).max(128),
  });

  router.post(
    '/admin/security/users/:id/disable-totp',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const targetId = parseInt(req.params.id, 10);
        if (Number.isNaN(targetId)) {
          throw new ValidationError('Invalid user ID');
        }
        if (targetId === req.user!.id) {
          // Self-disable goes through /totp/disable so the actor's own
          // password gate is the same code path as user-initiated
          // disable. Refusing here also keeps the audit log honest:
          // self-disable is recorded by /totp/disable, admin-disable is
          // recorded here.
          throw new ValidationError(
            'Use the personal Two-Factor Authentication card to disable your own 2FA.',
          );
        }
        const parsed = adminDisableTotpSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);
        const verified = await authService.loginUser(
          req.user!.username,
          parsed.data!.password,
        );
        if (!verified || verified.id !== req.user!.id) {
          throw new UnauthorizedError('Password did not match');
        }
        const target = await authService.getUserById(targetId);
        if (!target) {
          throw new NotFoundError('User not found');
        }
        // The admin Security panel exists to manage other admins'
        // second factors; non-admin accounts already have a self-service
        // disable flow and there is no operational reason for an admin
        // to remotely disable a regular user's TOTP through this
        // endpoint. Refusing here keeps the admin tool's blast radius
        // tightly scoped (Task #100).
        if (target.role !== 'admin') {
          throw new ValidationError(
            'This endpoint can only disable 2FA for admin accounts.',
          );
        }
        const wasEnabled = target.totpEnabled;
        // Same atomicity argument as the require-2fa toggle above:
        // disabling another admin's 2FA and writing the audit row must
        // succeed or fail together so we never have an unaudited
        // security state change (Task #100).
        await pgStorage.disableUserTotpWithAudit(targetId, {
          actorUserId: req.user!.id,
          actorIp: req.ip ?? null,
          action: 'user.totp_disabled_by_admin',
          targetUserId: targetId,
          metadata: {
            targetUsername: target.username,
            targetRole: target.role,
            wasEnabled,
          },
        });
        authService.invalidateUserCache(targetId);
        // Force-revoke every active session for the target so any
        // attacker-held cookie stops working immediately (Task #127).
        // Best-effort: helper logs and swallows session-store errors
        // — the DB-side disable already committed and must not be
        // rolled back by a session-table hiccup.
        await revokeAllSessionsForUser(targetId, 'admin_disabled_totp');
        // Mirror the admin-initiated disable into the structured log
        // stream alongside the DB security_audit_log row (Task #102).
        // The DB row is the canonical record; the log line is what an
        // operator sees when grepping live container output. `userId`
        // is the *target* (whose 2FA was turned off) so the line
        // matches the shape of the self-disable event.
        logger.warn('auth.totp.disabled', {
          event: 'totp_disabled',
          userId: targetId,
          requestId: (req as any).requestId,
          ip: req.ip,
          actorRole: 'admin',
        });
        res.json({ success: true });
      } catch (error) {
        logger.error('auth.admin.disable_totp_error', errorContext(error));
        next(error);
      }
    },
  );

  // Admin: paginated browser for the security audit log (Task #126).
  // Read-only counterpart to the WithAudit transactional helpers in
  // pgStorage — there is intentionally no DELETE/PATCH route, so a
  // compromised admin can't scrub their own actions out of the
  // history. Filters mirror the storage layer: `action` is an exact
  // match against the action code; `actorUsername` and
  // `targetUsername` are substring matches against the joined users
  // table. The page response also carries the distinct list of action
  // codes so the UI can populate its dropdown without hard-coding.
  router.get(
    '/admin/security/audit',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const querySchema = z.object({
          action: z.string().trim().max(100).optional(),
          actorUsername: z.string().trim().max(100).optional(),
          targetUsername: z.string().trim().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        });
        const parsed = querySchema.safeParse(req.query);
        throwOnInvalidInput(parsed);
        const page = await pgStorage.listSecurityAudit(parsed.data!);
        res.json(page);
      } catch (error) {
        logger.error('auth.admin.security_audit_list_error', errorContext(error));
        next(error);
      }
    },
  );

  // Get all users (admin only)
  router.get('/users', requireAuth, requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await authService.getAllUsers();
      const safeUsers = users.map(createSafeUser);
      res.json(safeUsers);
    } catch (error) {
      logger.error('auth.users.list_error', errorContext(error));
      next(error);
    }
  });

  // Set or clear the recovery email on a user account (admin only). The
  // password-reset flow needs an email on file to deliver a one-time
  // link, so this is the entry point operators use to enroll existing
  // accounts (or correct a typo) in account recovery.
  router.patch(
    '/users/:id/email',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) {
          throw new ValidationError('Invalid user ID');
        }
        const parsed = adminUpdateUserEmailSchema.safeParse(req.body);
        throwOnInvalidInput(parsed);

        const updated = await authService.updateUserEmail(
          userId,
          parsed.data!.email,
        );
        if (!updated) {
          throw new NotFoundError('User not found');
        }
        res.json({ success: true, user: createSafeUser(updated) });
      } catch (error) {
        logger.error('auth.users.email_update_error', errorContext(error));
        next(error);
      }
    },
  );

  // Admin-initiated password reset (Task #116). Sends a real reset
  // email to the target's recovery address from the operator console,
  // bypassing the public 3/hr/IP `passwordResetRequestLimiter` (which
  // exists to prevent enumeration of unauthenticated callers — an
  // authenticated admin already has the user list). The endpoint
  // surfaces every failure mode (missing user, no email on file,
  // SendGrid failure) so the operator gets a clear toast instead of
  // the generic "if an account exists..." response the public path
  // uses for anti-enumeration. One security_audit_log row is written
  // per call so it's auditable who triggered each reset, against whom.
  router.post(
    '/users/:id/send-reset-link',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      const actorUserId = req.user!.id;
      const actorIp = req.ip ?? null;
      const requestId = (req as any).requestId;
      const rawId = req.params.id;
      const targetId = parseInt(rawId, 10);

      // Helper to write the per-call audit row. Every call to this
      // endpoint produces exactly one row, success or failure, so a
      // compromised admin account can't probe ids/emails silently.
      // The full target email is intentionally never recorded — it
      // already lives on the user row and would be redundant PII in
      // the audit table. The domain alone is enough to spot "reset
      // link sent to a domain we don't recognize" anomalies later.
      // `auditWritten` is the per-call latch that guarantees the
      // catch-all fallback at the bottom only fires when no other
      // branch already recorded the outcome.
      let auditWritten = false;
      const writeAudit = async (
        outcome: { success: boolean; errorCode?: string },
        target: { id: number | null; username?: string; emailDomain?: string },
      ) => {
        auditWritten = true;
        try {
          await pgStorage.recordSecurityAudit({
            actorUserId,
            actorIp,
            action: 'user.password_reset_link_sent_by_admin',
            targetUserId: target.id,
            metadata: {
              ...(target.username !== undefined ? { targetUsername: target.username } : {}),
              ...(target.emailDomain !== undefined ? { targetEmailDomain: target.emailDomain } : {}),
              success: outcome.success,
              ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              rawTargetId: rawId,
            },
          });
        } catch (auditErr) {
          // Audit failures must never mask the original outcome — log
          // and continue. A monitoring alert on this log line catches
          // the (very rare) case where the audit table itself is sick.
          logger.error('auth.passwordReset.admin_audit_write_failed', errorContext(auditErr));
        }
      };

      try {
        if (Number.isNaN(targetId)) {
          await writeAudit({ success: false, errorCode: 'INVALID_USER_ID' }, { id: null });
          throw new ValidationError('Invalid user ID');
        }

        // Same baseUrl resolution as the public reset endpoint:
        // require APP_BASE_URL in production, fall back to the
        // request host in dev. Never trust the Host header in prod —
        // a poisoned Host could otherwise forge the link domain in
        // the outbound email even though only an admin can trigger it
        // (defence in depth against a compromised admin account).
        let baseUrl = process.env.APP_BASE_URL;
        if (!baseUrl) {
          if (process.env.NODE_ENV === 'production') {
            logger.error('auth.passwordReset.admin_missing_app_base_url');
            await writeAudit(
              { success: false, errorCode: 'APP_BASE_URL_NOT_CONFIGURED' },
              { id: targetId },
            );
            throw new ServiceUnavailableError(
              'Password reset is not configured on this server (APP_BASE_URL is unset).',
            );
          }
          baseUrl = `${req.protocol}://${req.get('host')}`;
        }

        const result = await authService.adminSendPasswordReset(
          targetId,
          baseUrl,
        );

        await writeAudit(
          { success: true },
          { id: targetId, username: result.targetUsername, emailDomain: result.targetEmailDomain },
        );

        // Mirror to the structured log so operators see it in the
        // live container output without joining against the DB. We
        // log the actor's id and the target's id only — no email
        // address — to keep the log line PII-free (Task #102/#104).
        logger.warn('auth.passwordReset.admin_sent', {
          actorUserId,
          targetUserId: targetId,
          requestId,
          ip: actorIp,
        });

        // Revoke the target's active sessions immediately (Task #127).
        // The threat: an admin only sends a reset link from the
        // operator console when the target's account is suspect — a
        // help-desk request after a possible compromise, an obviously
        // hijacked admin, etc. If the attacker is currently signed in,
        // letting their session ride until the target follows the
        // email link defeats the operator's intervention. Purging on
        // link-send (success path only) closes that window. Best-
        // effort by design — a session-store hiccup must not roll
        // back the just-issued reset token. Note this is intentionally
        // wider than "kill the attacker" — the legitimate target also
        // gets logged out everywhere and re-authenticates after the
        // reset, which is what they'd expect after an admin-initiated
        // reset anyway.
        await revokeAllSessionsForUser(
          targetId,
          'admin_password_reset_initiated',
        );

        res.json({ success: true });
      } catch (error) {
        // Failure-side audit. Most paths above already wrote their
        // own row (and the latch keeps us from double-writing). For
        // service-layer AppError throws that didn't, record with the
        // matching errorCode; for any unexpected non-AppError, record
        // a generic UNEXPECTED_ERROR row so the per-call audit
        // contract holds even when something genuinely unforeseen
        // bubbles up.
        if (!auditWritten) {
          if (error instanceof AppError) {
            await writeAudit(
              { success: false, errorCode: error.code },
              { id: Number.isNaN(targetId) ? null : targetId },
            );
          } else {
            await writeAudit(
              { success: false, errorCode: 'UNEXPECTED_ERROR' },
              { id: Number.isNaN(targetId) ? null : targetId },
            );
          }
        }
        logger.error(
          'auth.passwordReset.admin_send_error',
          errorContext(error),
        );
        next(error);
      }
    },
  );

  // Delete user (admin only)
  router.delete(
    '/users/:id',
    requireAuth,
    requireAdmin,
    async (req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) => {
      try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) {
          throw new ValidationError('Invalid user ID');
        }

        // Prevent self-deletion
        if (req.session && req.session.userId === userId) {
          throw new ValidationError('You cannot delete your own account');
        }

        const deleted = await authService.deleteUser(userId);
        if (!deleted) {
          throw new NotFoundError('User not found');
        }

        // Invalidate any active sessions belonging to the deleted user
        // so the cookie they're holding stops working immediately.
        // Shared helper (Task #127) handles the same SQL purge used by
        // admin-disable-TOTP and admin-initiated reset; failures are
        // logged inside, never thrown, since the user row is already
        // gone and requireAuth's user re-fetch will reject the next
        // authenticated request anyway.
        await revokeAllSessionsForUser(userId, 'user_deleted');

        res.json({ success: true });
      } catch (error) {
        logger.error('auth.users.delete_error', errorContext(error));
        next(error);
      }
    },
  );

  // Router-level error middleware. Every handler above either throws or
  // calls `next(err)`; this middleware is the single place that converts
  // an arbitrary thrown value into the wire-format JSON error response.
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) {
      const { status, body } = toSafeErrorResponse(err);
      res.status(status).json(body);
    }
  });

  return router;
}
