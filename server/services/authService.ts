/**
 * Authentication Service
 * 
 * Provides authentication and user management functionality.
 */

import { compare, hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, type InsertUser, type User } from '../../shared/schema';

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  /**
   * Register a new user
   * 
   * @param username Username
   * @param password Password (plaintext, will be hashed)
   * @returns Created user
   */
  async registerUser(username: string, password: string): Promise<User> {
    // Check if user already exists
    const existingUser = await this.getUserByUsername(username);
    if (existingUser) {
      throw new AuthError(`User with username ${username} already exists`);
    }

    // Hash password
    const hashedPassword = await hash(password, 10);

    // Create user
    const userData: InsertUser = {
      username,
      password: hashedPassword,
      role: 'user' // Default role
    };

    const result = await db.insert(users).values(userData).returning();
    return result[0];
  }

  /**
   * Login a user
   * 
   * @param username Username
   * @param password Password (plaintext)
   * @returns User if authentication successful, null otherwise
   */
  async loginUser(username: string, password: string): Promise<User | null> {
    // Find user by username
    const user = await this.getUserByUsername(username);
    if (!user) {
      return null;
    }

    // Verify password
    const passwordMatch = await compare(password, user.password);
    if (!passwordMatch) {
      return null;
    }

    return user;
  }

  /**
   * Get user by ID
   * 
   * @param id User ID
   * @returns User if found, undefined otherwise
   */
  async getUserById(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  /**
   * Get user by username
   * 
   * @param username Username
   * @returns User if found, undefined otherwise
   */
  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  /**
   * Create initial admin user if no users exist in the database
   * 
   * @param username Default admin username
   * @param password Default admin password
   * @returns Created admin user or null if users already exist
   */
  async createInitialAdmin(username: string, password: string): Promise<User | null> {
    // Check if users exist
    const existingUsers = await db.select().from(users);
    if (existingUsers.length > 0) {
      return null;
    }

    // Hash password
    const hashedPassword = await hash(password, 10);

    // Create admin user
    const adminData: InsertUser = {
      username,
      password: hashedPassword,
      role: 'admin'
    };

    const result = await db.insert(users).values(adminData).returning();
    return result[0];
  }
}

export const authService = new AuthService();