import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from '../api/client';

interface AuthState {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Token disimpan HANYA di memory (state React), BUKAN localStorage — demi
 * keamanan (mengurangi permukaan serangan XSS terhadap token). Trade-off yang
 * disengaja: refresh halaman = harus login lagi. Lihat m4.1.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      async login(email, password) {
        const res = await api.login(email, password);
        setToken(res.token);
        setUser(res.user);
      },
      async register(email, password) {
        await api.register(email, password);
        // Setelah register, langsung login supaya alur mulus.
        const res = await api.login(email, password);
        setToken(res.token);
        setUser(res.user);
      },
      logout() {
        setToken(null);
        setUser(null);
      },
    }),
    [user, token],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider');
  return ctx;
}
