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
import { authService } from '../services/authService';
import { totpService } from '../services/totpService';
import { createSafeUser, requireAuth, requireAdmin } from '../middleware/auth';
import { z } from 'zod';
import {
  adminCreateUserSchema,
  adminUpdateUserEmailSchema,
  strongPasswordSchema,
} from '../../shared/schema';
import {
  AuthError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  sendError,
  toSafeErrorResponse,
} from '../errors';
import {
  authLimiter,
  passwordResetRequestLimiter,
  totpVerifyLimiter,
} from '../middleware/rateLimiter';
import { SESSION_COOKIE_NAME } from '../sessionConfig';
import { pool } from '../db';

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

      res.json(createSafeUser(user));
    } catch (error) {
      console.error('Error checking authentication:', error);
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
        console.log('Authentication failed');
        throw new UnauthorizedError('Invalid username or password');
      }

      // Ensure session exists
      if (!req.session) {
        console.error('No session object available');
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
          console.error('Error regenerating session for TOTP step:', regenErr);
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
        console.error('Error regenerating session:', regenErr);
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

      console.log('User authenticated successfully');

      // Persist the new session before responding.
      try {
        await new Promise<void>((resolve, reject) => {
          req.session.save((err: Error | null) => {
            if (err) reject(err); else resolve();
          });
        });
      } catch (saveErr) {
        console.error('Error saving session:', saveErr);
        // Tear down the partially-populated session so no half-authenticated
        // state can leak to the client.
        await new Promise<void>((resolve) => {
          req.session.destroy(() => resolve());
        });
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        throw new Error('Session initialization failed');
      }

      console.log('Session saved successfully');

      res.json({
        success: true,
        user: createSafeUser(user)
      });
    } catch (error) {
      console.error('Error during login:', error);
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

        const ok = await totpService.verifyLoginCode(
          candidateId,
          parsed.data!.code,
        );
        if (!ok) {
          throw new UnauthorizedError('Invalid verification code');
        }

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
          console.error('Error regenerating session post-TOTP:', regenErr);
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
          console.error('Error saving session post-TOTP:', saveErr);
          await new Promise<void>((resolve) =>
            req.session.destroy(() => resolve()),
          );
          res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
          throw new Error('Session initialization failed');
        }

        res.json({ success: true, user: createSafeUser(user) });
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
        const result = await totpService.beginEnrollment(req.user!);
        res.json(result);
      } catch (error) {
        console.error('Error beginning TOTP enrollment:', error);
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
        await totpService.disable(req.user!.id);
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
          console.error(
            '[auth/request-reset] APP_BASE_URL is not set in production; ' +
              'refusing to construct reset link from untrusted Host header.',
          );
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
              console.error('Error issuing password reset:', err),
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
        console.error('Error completing password reset:', error);
        next(error);
      }
    },
  );

  // Logout endpoint
  router.post('/logout', (req: Request & { session?: any }, res: Response) => {
    if (req.session) {
      console.log('Processing logout request');

      req.session.destroy((err: Error | null) => {
        if (err) {
          console.error('Error destroying session:', err);
          // Inside a synchronous callback, no `next` available — use the
          // sanitizer directly so the response shape stays consistent.
          return sendError(res, new Error('Failed to logout'));
        }

        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        res.json({ success: true });
      });
    } else {
      console.log('Logout attempted with no active session');
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
      console.error('Error during registration:', error);
      next(error);
    }
  });

  // Get all users (admin only)
  router.get('/users', requireAuth, requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await authService.getAllUsers();
      const safeUsers = users.map(createSafeUser);
      res.json(safeUsers);
    } catch (error) {
      console.error('Error fetching users:', error);
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
        console.error('Error updating user email:', error);
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
        // The connect-pg-simple `sessions` table stores the session
        // payload as JSON in `sess`. Compare the `userId` field as a
        // string ($1::text) so a malformed/non-numeric payload from
        // an unrelated session can't blow up the DELETE with a cast
        // error and cause us to skip the purge entirely.
        try {
          await pool.query(
            `DELETE FROM sessions WHERE sess->>'userId' = $1::text`,
            [userId],
          );
        } catch (sessionErr) {
          // Don't fail the request — the user row is already gone, so
          // the next authenticated request will be rejected by
          // requireAuth's user re-fetch anyway. Log so an operator can
          // investigate the session-store hiccup.
          console.error(
            'Failed to purge sessions for deleted user:',
            sessionErr,
          );
        }

        res.json({ success: true });
      } catch (error) {
        console.error('Error deleting user:', error);
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
