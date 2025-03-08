/**
 * Authentication Routes
 * 
 * Provides endpoints for login, logout, and user management.
 */

import { Router, Request, Response } from 'express';
import { authService } from '../services/authService';
import { createSafeUser } from '../middleware/auth';
import { z } from 'zod';

// Login validation schema
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export function createAuthRouter(): Router {
  const router = Router();

  // Get current authenticated user
  router.get('/me', async (req: Request & { session?: { userId?: number } }, res: Response) => {
    try {
      if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const user = await authService.getUserById(req.session.userId);
      if (!user) {
        // User ID in session but not found in database - clear session
        req.session.userId = undefined;
        return res.status(401).json({ error: 'User not found' });
      }

      // Return safe user object (no password)
      res.json(createSafeUser(user));
    } catch (error) {
      console.error('Error getting current user:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Login endpoint
  router.post('/login', async (req: Request & { session?: any }, res: Response) => {
    try {
      // Validate request body
      const validation = loginSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          error: 'Invalid input', 
          details: validation.error.errors 
        });
      }

      const { username, password } = validation.data;

      // Authenticate user
      const user = await authService.loginUser(username, password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Set user in session
      req.session.userId = user.id;
      req.session.username = user.username;

      // Return safe user object (no password)
      res.json(createSafeUser(user));
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error during login' });
    }
  });

  // Logout endpoint
  router.post('/logout', (req: Request & { session?: any }, res: Response) => {
    try {
      // Clear session
      if (req.session) {
        req.session.destroy((err: any) => {
          if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ error: 'Could not log out' });
          }
          res.json({ success: true, message: 'Logged out successfully' });
        });
      } else {
        res.json({ success: true, message: 'Already logged out' });
      }
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Server error during logout' });
    }
  });

  return router;
}