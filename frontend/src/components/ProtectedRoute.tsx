import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';

/** Batasi akses route ke user yang sudah login; kalau belum → redirect ke /login. */
export function ProtectedRoute({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const { token, user, ready } = useAuth();
  // Wait for the session restore; redirecting earlier would bounce signed-in users.
  if (!ready)
    return (
      <p role="status" className="p-8 text-center text-muted">
        Memuat sesi...
      </p>
    );
  if (!token) return <Navigate to="/login" replace />;
  if (admin && user?.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
