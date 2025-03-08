/**
 * Authentication Middleware
 * 
 * Provides functionality for securing routes with user authentication.
 */

import { Request, Response, NextFunction } from "express";

interface RequestWithSession extends Request {
  session: {
    userId?: number;
    username?: string;
    [key: string]: any;
  };
}

/**
 * Middleware to check if a user is authenticated
 * If not authenticated, returns 401 Unauthorized
 */
export function requireAuth(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Unauthorized", message: "You must be logged in to access this resource." });
  }
  
  next();
}

/**
 * Middleware to validate admin status (can be customized as needed)
 */
export function requireAdmin(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Unauthorized", message: "You must be logged in to access this resource." });
  }
  
  // Additional admin validation can be added here if needed
  
  next();
}

/**
 * Creates a user object for frontend with safe data
 */
export function createSafeUser(user: any) {
  // Return only safe user data (no password or sensitive info)
  return {
    id: user.id,
    username: user.username,
  };
}