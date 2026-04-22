import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import ResetPassword from "@/pages/ResetPassword";
import ForcePasswordChange from "@/pages/ForcePasswordChange";
import Admin from "@/pages/Admin";
import McpAudit from "@/pages/McpAudit";
import SyncAudit from "@/pages/SyncAudit";
import GiftCardTest from "@/pages/GiftCardTest";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEffect } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";

// Authentication-aware router
function Router() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const [location, navigate] = useLocation();

  // Global navigation guard
  useEffect(() => {
    // If not loading and not on login/register page and not authenticated, redirect to login
    if (!isLoading &&
        !isAuthenticated &&
        location !== '/login' &&
        location !== '/register' &&
        location !== '/reset') {
      navigate('/login');
    }
  }, [isLoading, isAuthenticated, location, navigate]);

  // Forced password rotation (Task #55): if the authenticated user's
  // stored password predates the current strong-password policy,
  // refuse to render anything except the dedicated change-password
  // screen and the public /reset page (which is where the email link
  // lands to actually complete the rotation).
  if (
    !isLoading &&
    isAuthenticated &&
    user?.mustRotatePassword &&
    location !== '/reset'
  ) {
    return <ForcePasswordChange />;
  }

  return (
    <Switch>
      {/* Public routes */}
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/reset" component={ResetPassword} />
      
      {/* Protected routes */}
      <Route path="/">
        {() => (
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        )}
      </Route>
      
      <Route path="/admin">
        {() => (
          <ProtectedRoute requiredRole="admin">
            <Admin />
          </ProtectedRoute>
        )}
      </Route>

      <Route path="/admin/mcp-audit">
        {() => (
          <ProtectedRoute requiredRole="admin">
            <McpAudit />
          </ProtectedRoute>
        )}
      </Route>

      <Route path="/admin/sync-audit">
        {() => (
          <ProtectedRoute requiredRole="admin">
            <SyncAudit />
          </ProtectedRoute>
        )}
      </Route>
      
      <Route path="/gift-card-test">
        {() => (
          <ProtectedRoute requiredRole="admin">
            <GiftCardTest />
          </ProtectedRoute>
        )}
      </Route>
      
      {/* Fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// App wrapper
function AppContent() {
  useWebSocket();

  return (
    <AuthProvider>
      <ThemeProvider>
        <Router />
        <Toaster />
      </ThemeProvider>
    </AuthProvider>
  );
}

// Root component
function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
