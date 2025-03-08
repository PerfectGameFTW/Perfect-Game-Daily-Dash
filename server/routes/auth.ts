/**
 * Authentication Routes
 * 
 * Provides endpoints for login, logout, and user management.
 */

import { Router, Request, Response } from 'express';
import { authService } from '../services/authService';
import { createSafeUser } from '../middleware/auth';
import { z } from 'zod';

// Validation schemas
const loginSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100)
});

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
  role: z.enum(['user', 'admin']).default('user')
});

export function createAuthRouter(): Router {
  const router = Router();

  // Current user endpoint
  router.get('/me', async (req: Request & { session?: { userId?: number } }, res: Response) => {
    try {
      if (!req.session || !req.session.userId) {
        return res.json(null);
      }

      const user = await authService.getUserById(req.session.userId);
      
      if (!user) {
        // Clear invalid session if user no longer exists
        req.session.userId = undefined;
        return res.json(null);
      }

      res.json(createSafeUser(user));
    } catch (error) {
      console.error('Error checking authentication:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Login endpoint
  router.post('/login', async (req: Request & { session?: any }, res: Response) => {
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
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Set user ID in session
      req.session.userId = user.id;
      req.session.username = user.username;
      
      res.json({
        success: true,
        user: createSafeUser(user)
      });
    } catch (error) {
      console.error('Error during login:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Logout endpoint
  router.post('/logout', (req: Request & { session?: any }, res: Response) => {
    if (req.session) {
      req.session.destroy((err: Error) => {
        if (err) {
          console.error('Error destroying session:', err);
          return res.status(500).json({ error: 'Failed to logout' });
        }
        
        res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  });

  // Register endpoint
  router.post('/register', async (req: Request & { session?: any }, res: Response) => {
    try {
      // Validate input
      const validationResult = registerSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: 'Invalid input',
          details: validationResult.error.format()
        });
      }

      const { username, password, role } = validationResult.data;
      
      try {
        const user = await authService.registerUser(username, password, role);
        
        // Set user ID in session
        req.session.userId = user.id;
        req.session.username = user.username;
        
        res.json({
          success: true,
          user: createSafeUser(user)
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) {
          return res.status(409).json({ error: 'Username already exists' });
        }
        throw err; // Re-throw for the outer catch
      }
    } catch (error) {
      console.error('Error during registration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}