/**
 * Authentication Middleware
 * 
 * Provides functionality for securing routes with user authentication.
 */

import { Request, Response, NextFunction } from 'express';
import { Session } from 'express-session';
import { User } from '../../shared/schema';

// Extended request type with session
interface RequestWithSession extends Request {
  session: Session & {
    userId?: number;
    username?: string;
  };
}

/**
 * Middleware to check if a user is authenticated
 * If not authenticated, returns 401 Unauthorized
 */
export function requireAuth(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

/**
 * Middleware to validate admin status (can be customized as needed)
 */
export function requireAdmin(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Get user role from database and check if admin
  // For now, we'll use a placeholder implementation
  import('../services/authService').then(({ authService }) => {
    authService.getUserById(req.session!.userId!)
      .then(user => {
        if (!user || user.role !== 'admin') {
          return res.status(403).json({ error: 'Forbidden: Admin access required' });
        }
        next();
      })
      .catch(err => {
        console.error('Error checking admin status:', err);
        res.status(500).json({ error: 'Internal server error' });
      });
  });
}

/**
 * Creates a user object for frontend with safe data
 */
export function createSafeUser(user: any) {
  if (!user) return null;
  
  // Return only safe user data (exclude password)
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}