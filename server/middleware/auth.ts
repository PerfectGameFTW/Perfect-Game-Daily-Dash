/**
 * Authentication Middleware
 * 
 * Provides functionality for securing routes with user authentication.
 */

import { Request, Response, NextFunction } from "express";
import { User } from "../../shared/schema";

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
    return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
  }
  
  next();
}

/**
 * Middleware to validate admin status (can be customized as needed)
 */
export function requireAdmin(req: Request & { session?: { userId?: number } }, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
  }
  
  // Here we would check if the user is an admin
  // For now, we'll leave this as a placeholder
  // In a real implementation, we'd fetch the user and check their role
  
  next();
}

/**
 * Creates a user object for frontend with safe data
 */
export function createSafeUser(user: any) {
  if (!user) return null;
  
  // Return user without password
  const { password, ...safeUser } = user;
  return safeUser;
}