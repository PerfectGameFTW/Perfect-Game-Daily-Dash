/**
 * Authentication Middleware
 * 
 * Provides functionality for securing routes with user authentication.
 */

import { Request, Response, NextFunction } from 'express';

// Extended Request with session
interface RequestWithSession extends Request {
  session: {
    userId?: number;
    username?: string;
    [key: string]: any;
  };
}

/**
 * Middleware to check if a user is authenticated
 * If not authenticated, redirects to login page
 */
export function requireAuth(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (req.session && req.session.userId) {
    next();
  } else {
    // API calls should return 401 Unauthorized
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required' });
    } else {
      // For web pages, redirect to login
      res.redirect('/login');
    }
  }
}

/**
 * Middleware to validate admin status (can be customized as needed)
 */
export function requireAdmin(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (req.session && req.session.userId) {
    // Check if user is admin - this can be enhanced with proper role checking
    // For now we're just assuming any authenticated user is an admin
    next();
  } else {
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ error: 'Admin access required' });
    } else {
      res.redirect('/login');
    }
  }
}

/**
 * Creates a user object for frontend with safe data
 */
export function createSafeUser(user: any) {
  if (!user) return null;
  
  return {
    id: user.id,
    username: user.username
    // Add any other non-sensitive user data here
  };
}