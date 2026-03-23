/**
 * Authentication Routes
 * 
 * Provides endpoints for login, logout, and user management.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService';
import { createSafeUser, requireAuth, requireAdmin } from '../middleware/auth';
import { z } from 'zod';
import { authLimiter } from '../middleware/rateLimiter';

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

// Custom middleware to ensure only admins can register new users
const adminOrInitialUserMiddleware = async (req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) => {
  try {
    // Always allow the initial user creation
    const usersExist = await authService.checkUsersExist();
    if (!usersExist) {
      return next();
    }
    
    // For subsequent user registrations, require admin access
    requireAdmin(req, res, next);
  } catch (error) {
    console.error('Error in admin middleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export function createAuthRouter(): Router {
  const router = Router();

  // Current user endpoint
  router.get('/me', async (req: Request & { session?: any }, res: Response) => {
    try {
      if (!req.session) {
        console.log('GET /api/auth/me - No session found');
        return res.json(null);
      }
      
      console.log('GET /api/auth/me - Session found, userId:', req.session.userId);
      
      if (!req.session.userId) {
        console.log('GET /api/auth/me - No userId in session');
        return res.json(null);
      }

      console.log(`GET /api/auth/me - Fetching user with ID: ${req.session.userId}`);
      const user = await authService.getUserById(req.session.userId);
      
      if (!user) {
        console.log(`GET /api/auth/me - No user found with ID: ${req.session.userId}`);
        // Clear invalid session if user no longer exists
        req.session.userId = undefined;
        await new Promise<void>((resolve) => {
          req.session.save(() => resolve());
        });
        return res.json(null);
      }

      const safeUser = createSafeUser(user);
      if (safeUser) {
        console.log(`GET /api/auth/me - Successfully retrieved user: ${safeUser.username} (Role: ${safeUser.role})`);
      }
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
      console.log(`Login attempt for username: ${username}`);
      
      const user = await authService.loginUser(username, password);

      if (!user) {
        console.log(`Authentication failed for username: ${username}`);
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Ensure session exists
      if (!req.session) {
        console.error('No session object available');
        return res.status(500).json({ error: 'Session initialization failed' });
      }

      // Set user information in session
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      
      console.log(`User authenticated successfully: ${username} (ID: ${user.id}, Role: ${user.role})`);
      
      // Save session explicitly to ensure it's stored before response
      await new Promise<void>((resolve, reject) => {
        req.session.save((err: Error | null) => {
          if (err) {
            console.error('Error saving session:', err);
            reject(err);
          } else {
            console.log('Session saved successfully with userId:', req.session.userId);
            resolve();
          }
        });
      });
      
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
      console.log(`Logging out user: ${req.session.username || 'Unknown'} (ID: ${req.session.userId || 'Unknown'})`);
      
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

  // Register endpoint - protected for admin-only use after initial user
  router.post('/register', adminOrInitialUserMiddleware, async (req: Request & { session?: any }, res: Response) => {
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
        
        // Only set session if it's the initial registration or self-registration
        const usersCount = await authService.getUsersCount();
        if (usersCount === 1) {
          // This is the first user, set session
          req.session.userId = user.id;
          req.session.username = user.username;
          req.session.role = user.role;
          
          // Save session explicitly for the first user
          await new Promise<void>((resolve, reject) => {
            req.session.save((err: Error | null) => {
              if (err) {
                console.error('Error saving session during initial registration:', err);
                reject(err);
              } else {
                console.log(`Session saved for first user: ${user.username} (ID: ${user.id})`);
                resolve();
              }
            });
          });
        }
        
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