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
   * @param role User role (default: 'user')
   * @returns Created user
   */
  async registerUser(username: string, password: string, role: string = 'user'): Promise<User> {
    // Check if user already exists
    const existingUser = await this.getUserByUsername(username);
    if (existingUser) {
      throw new AuthError(`User with username ${username} already exists`);
    }

    // Hash password
    const hashedPassword = await hash(password, 10);

    // Create user with validated role
    const userData: InsertUser = {
      username,
      password: hashedPassword,
      role: (role === 'admin' ? 'admin' : 'user') as 'user' | 'admin'
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

  /**
   * Check if any users exist in the database
   * 
   * @returns True if users exist, false otherwise
   */
  async checkUsersExist(): Promise<boolean> {
    const count = await this.getUsersCount();
    return count > 0;
  }

  /**
   * Get the total number of users in the system
   * 
   * @returns The count of users
   */
  async getUsersCount(): Promise<number> {
    const result = await db.select().from(users);
    return result.length;
  }

  /**
   * Get all users in the system
   * 
   * @returns Array of all users
   */
  async getAllUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  /**
   * Reset a user's password by username.
   *
   * @param username Username
   * @param newPassword New plaintext password (will be hashed)
   * @returns True if password was reset, false if user not found
   */
  async resetPassword(username: string, newPassword: string): Promise<boolean> {
    const user = await this.getUserByUsername(username);
    if (!user) {
      return false;
    }
    const hashedPassword = await hash(newPassword, 10);
    await db.update(users).set({ password: hashedPassword }).where(eq(users.id, user.id));
    return true;
  }

  /**
   * Delete a user by ID
   * 
   * @param id User ID to delete
   * @returns True if user was deleted, false if not found
   */
  async deleteUser(id: number): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }
}

export const authService = new AuthService();