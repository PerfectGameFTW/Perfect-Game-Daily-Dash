/**
 * Authentication Service
 * 
 * Provides authentication and user management functionality.
 */

import bcrypt from 'bcryptjs';
import { pgStorage } from '../pgStorage';
import { InsertUser, User } from '@shared/schema';

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
    // Check if username already exists
    const existingUser = await pgStorage.getUserByUsername(username);
    if (existingUser) {
      throw new AuthError('Username already exists');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user with hashed password
    const userData: InsertUser = {
      username,
      password: hashedPassword,
    };

    return await pgStorage.createUser(userData);
  }

  /**
   * Login a user
   * 
   * @param username Username
   * @param password Password (plaintext)
   * @returns User if authentication successful, null otherwise
   */
  async loginUser(username: string, password: string): Promise<User | null> {
    // Get user by username
    const user = await pgStorage.getUserByUsername(username);
    if (!user) {
      return null;
    }

    // Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
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
    return await pgStorage.getUser(id);
  }

  /**
   * Create initial admin user if no users exist in the database
   * 
   * @param username Default admin username
   * @param password Default admin password
   * @returns Created admin user or null if users already exist
   */
  async createInitialAdmin(username: string, password: string): Promise<User | null> {
    try {
      // Check if any users exist
      const users = await pgStorage.getAllUsers();
      if (users && users.length > 0) {
        return null; // Don't create admin if users already exist
      }

      // Create admin user
      return await this.registerUser(username, password);
    } catch (error) {
      console.error('Error creating initial admin:', error);
      return null;
    }
  }
}

export const authService = new AuthService();