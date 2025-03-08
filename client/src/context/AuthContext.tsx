import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { queryClient } from '@/lib/queryClient';

interface User {
  id: number;
  username: string;
  role?: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check authentication status on initial load
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      setIsLoading(true);
      console.log('Checking authentication status...');
      const response = await fetch('/api/auth/me');
      
      if (response.ok) {
        const userData = await response.json();
        console.log('Auth check response:', userData);
        if (userData) {
          // Only set as authenticated if we got actual user data back
          setUser(userData);
          setIsAuthenticated(true);
          console.log('User authenticated:', userData);
        } else {
          // Server returned OK but no user data (null)
          console.log('No user data returned');
          setUser(null);
          setIsAuthenticated(false);
        }
      } else {
        // Server returned an error
        console.log('Auth check failed with status:', response.status);
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Auth check error:', error);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      console.log(`Attempting login for user: ${username}`);
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        const responseData = await response.json();
        console.log('Login response:', responseData);
        
        if (responseData.success && responseData.user) {
          setUser(responseData.user);
          setIsAuthenticated(true);
          
          // Trigger a state change and return after a short delay to ensure
          // React has time to process state changes
          await new Promise(resolve => setTimeout(resolve, 100));
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error('Login error:', error);
      return false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      console.log('Logging out...');
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      console.log('Logout response status:', response.status);
      
      setUser(null);
      setIsAuthenticated(false);
      
      // Clear any authenticated queries from the cache
      await queryClient.invalidateQueries();
      
      console.log('Logout complete, user state cleared');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const value = {
    user,
    isLoading,
    isAuthenticated,
    login,
    logout,
    checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  
  return context;
}