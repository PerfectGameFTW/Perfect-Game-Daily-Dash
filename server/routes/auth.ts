/**
 * Authentication Routes
 * 
 * Provides endpoints for login, logout, and user management.
 */

import { Router, Request, Response } from 'express';
import { authService } from '../services/authService';
import { createSafeUser, requireAuth, requireAdmin } from '../middleware/auth';
import { z } from 'zod';
import { adminCreateUserSchema, strongPasswordSchema } from '../../shared/schema';
import { authLimiter, passwordResetRequestLimiter } from '../middleware/rateLimiter';

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

export function createAuthRouter(): Router {
  const router = Router();

  // Current user endpoint
  router.get('/me', async (req: Request & { session?: any }, res: Response) => {
    try {
      if (!req.session) {
        return res.json(null);
      }
      
      if (!req.session.userId) {
        return res.json(null);
      }

      const user = await authService.getUserById(req.session.userId);
      
      if (!user) {
        // Clear invalid session if user no longer exists
        req.session.userId = undefined;
        await new Promise<void>((resolve) => {
          req.session.save(() => resolve());
        });
        return res.json(null);
      }

      const safeUser = createSafeUser(user);
      res.json(safeUser);
    } catch (error) {
      console.error('Error checking authentication:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/login', authLimiter, async (req: Request & { session?: any }, res: Response) => {
    try {
      // Validate input
      const validationResult = loginSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: 'Invalid input',
          details: validationResult.error.format()
        });
      }

      const { username, password } = validationResult.data;
      
      const user = await authService.loginUser(username, password);

      if (!user) {
        console.log('Authentication failed');
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Ensure session exists
      if (!req.session) {
        console.error('No session object available');
        return res.status(500).json({ error: 'Session initialization failed' });
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
        return res.status(500).json({ error: 'Session initialization failed' });
      }

      // Populate the fresh session with authenticated user info.
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;

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
        res.clearCookie('pg.sid');
        return res.status(500).json({ error: 'Session initialization failed' });
      }

      console.log('Session saved successfully');

      res.json({
        success: true,
        user: createSafeUser(user)
      });
    } catch (error) {
      console.error('Error during login:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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
    async (req: Request, res: Response) => {
      try {
        const validation = completeResetSchema.safeParse(req.body);
        if (!validation.success) {
          return res.status(400).json({
            error: 'Invalid input',
            details: validation.error.format(),
          });
        }

        const { token, newPassword } = validation.data;
        const success = await authService.completePasswordReset(
          token,
          newPassword,
        );

        if (!success) {
          return res.status(400).json({
            error:
              'This reset link is invalid or has expired. Please request a new one.',
          });
        }

        res.json({ success: true });
      } catch (error) {
        console.error('Error completing password reset:', error);
        res.status(500).json({ error: 'Internal server error' });
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
          return res.status(500).json({ error: 'Failed to logout' });
        }
        
        res.clearCookie('pg.sid');
        res.json({ success: true });
      });
    } else {
      console.log('Logout attempted with no active session');
      res.json({ success: true });
    }
  });

  // Register endpoint — admin-only. Creating the first admin happens
  // out-of-band via the bootstrap CLI script (see replit.md), never here.
  router.post('/register', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const validationResult = adminCreateUserSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Invalid input',
          details: validationResult.error.format(),
        });
      }

      const { username, password, role } = validationResult.data;

      try {
        const user = await authService.registerUser(username, password, role);
        res.json({
          success: true,
          user: createSafeUser(user),
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) {
          return res.status(409).json({ error: 'Username already exists' });
        }
        throw err;
      }
    } catch (error) {
      console.error('Error during registration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get all users (admin only)
  router.get('/users', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const users = await authService.getAllUsers();
      // Transform users to safe format
      const safeUsers = users.map(createSafeUser);
      res.json(safeUsers);
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete user (admin only)
  router.delete('/users/:id', requireAuth, requireAdmin, async (req: Request & { session?: { userId?: number } }, res: Response) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }

      // Prevent self-deletion
      if (req.session && req.session.userId === userId) {
        return res.status(400).json({ error: 'You cannot delete your own account' });
      }

      const deleted = await authService.deleteUser(userId);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}