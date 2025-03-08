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
  
  // Get current authenticated user
  router.get('/me', async (req: Request & { session?: { userId?: number } }, res: Response) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: "Unauthorized", message: "Not authenticated" });
    }
    
    try {
      const user = await authService.getUserById(req.session.userId);
      
      if (!user) {
        // User ID in session but not found in DB
        req.session.userId = undefined;
        return res.status(401).json({ error: "Unauthorized", message: "User not found" });
      }
      
      // Return safe user object (no password)
      return res.json(createSafeUser(user));
    } catch (error) {
      console.error("Error fetching user:", error);
      return res.status(500).json({ error: "Internal Server Error", message: "Failed to fetch user data" });
    }
  });
  
  // Login endpoint
  router.post('/login', async (req: Request & { session?: any }, res: Response) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Bad Request", message: "Username and password are required" });
    }
    
    try {
      const user = await authService.loginUser(username, password);
      
      if (!user) {
        return res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
      }
      
      // Set user ID in session
      req.session.userId = user.id;
      req.session.username = user.username;
      
      // Return safe user object (no password)
      return res.json(createSafeUser(user));
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ error: "Internal Server Error", message: "Login failed" });
    }
  });
  
  // Logout endpoint
  router.post('/logout', (req: Request & { session?: any }, res: Response) => {
    if (req.session) {
      req.session.destroy((err: Error) => {
        if (err) {
          return res.status(500).json({ error: "Internal Server Error", message: "Logout failed" });
        }
        
        res.json({ success: true, message: "Logged out successfully" });
      });
    } else {
      res.json({ success: true, message: "Already logged out" });
    }
  });
  
  return router;
}