import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Admin from "@/pages/Admin";
import GiftCardTest from "@/pages/GiftCardTest";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEffect } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";

// Authentication-aware router
function Router() {
  const { isAuthenticated, isLoading } = useAuth();
  const [location, navigate] = useLocation();
  
  // Global navigation guard
  useEffect(() => {
    // If not loading and not on login/register page and not authenticated, redirect to login
    if (!isLoading && 
        !isAuthenticated && 
        location !== '/login' && 
        location !== '/register') {
      navigate('/login');
    }
  }, [isLoading, isAuthenticated, location, navigate]);
  
  return (
    <Switch>
      {/* Public routes */}
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      
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
