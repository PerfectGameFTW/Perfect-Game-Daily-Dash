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
import { authLimiter } from '../middleware/rateLimiter';

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

const resetPasswordSchema = z.object({
  username: z.string().min(3).max(50),
  newPassword: strongPasswordSchema,
});

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

  // Reset password endpoint
  router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
    try {
      const validationResult = resetPasswordSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Invalid input',
          details: validationResult.error.format()
        });
      }

      const { username, newPassword } = validationResult.data;
      const success = await authService.resetPassword(username, newPassword);

      if (!success) {
        return res.status(400).json({ error: 'Unable to reset password. Please check your username and try again.' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error resetting password:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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