/**
 * Authentication Routes
 * 
 * Provides endpoints for login, logout, and user management.
 */

import { Router, Request, Response } from "express";
import { authService } from "../services/authService";
import { createSafeUser } from "../middleware/auth";

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/me', async (req: Request & { session?: { userId?: number } }, res: Response) => {
    try {
      if (!req.session || !req.session.userId) {
        return res.json({ user: null });
      }

      const user = await authService.getUserById(req.session.userId);
      return res.json({ user: createSafeUser(user) });
    } catch (error) {
      console.error('Error in /me route:', error);
      return res.status(500).json({ error: 'Error fetching user' });
    }
  });

  router.post('/login', async (req: Request & { session?: any }, res: Response) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      
      const user = await authService.loginUser(username, password);
      
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      
      // Set session data
      req.session.userId = user.id;
      req.session.username = user.username;
      
      return res.json({ user: createSafeUser(user) });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Error during login' });
    }
  });

  router.post('/logout', (req: Request & { session?: any }, res: Response) => {
    if (req.session) {
      req.session.destroy((err: Error) => {
        if (err) {
          return res.status(500).json({ error: 'Error during logout' });
        }
        res.clearCookie('connect.sid');
        return res.json({ success: true });
      });
    } else {
      return res.json({ success: true });
    }
  });

  return router;
}