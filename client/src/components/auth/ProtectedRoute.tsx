/**
 * Protected Route Component
 * 
 * Wraps routes that require authentication and redirects 
 * unauthenticated users to the login page.
 */

import { ReactNode, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: ReactNode;
  requireAdmin?: boolean;
}

export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    // Wait until authentication state is loaded
    if (!isLoading) {
      // Redirect if not authenticated
      if (!user) {
        // Encode the current path to redirect back after login
        const redirectPath = encodeURIComponent(location);
        setLocation(`/login?redirectTo=${redirectPath}`);
      }
      
      // If admin access is required, check user role
      if (requireAdmin && user && user.role !== 'admin') {
        // User is authenticated but not an admin
        setLocation('/dashboard'); // Redirect to regular dashboard
      }
    }
  }, [user, isLoading, location, setLocation, requireAdmin]);

  // Show loading indicator while checking authentication
  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <div className="flex flex-col items-center space-y-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-lg text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // If user is authenticated (and is admin if required), render children
  if (user && (!requireAdmin || user.role === 'admin')) {
    return <>{children}</>;
  }

  // This will only briefly show before the redirect happens
  return null;
}