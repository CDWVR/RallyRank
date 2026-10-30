import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { savePostAuthRedirect } from '@/lib/authHelpers';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-t-2 border-b-2 border-primary" />
          <p className="text-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    const redirect = `${location.pathname}${location.search}`;
    savePostAuthRedirect(redirect);
    return (
      <Navigate
        to={`/auth?redirect=${encodeURIComponent(redirect)}`}
        replace
        state={{ from: redirect }}
      />
    );
  }

  return <>{children}</>;
};

export default ProtectedRoute;
