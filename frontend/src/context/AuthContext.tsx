import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type Session, type User } from '../api/client';

interface AuthState {
  user: User | null;
  token: string | null;
  /** False until the initial session restore (refresh cookie) has finished. */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Renew this long before the access token expires. */
const RENEW_BEFORE_MS = 60_000;

function expiryOf(token: string): number | null {
  try {
    const payload = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    const { exp } = JSON.parse(atob(payload)) as { exp: number };
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Session model:
 * - The access token (JWT, 15 minutes) lives ONLY in memory, never in localStorage,
 *   so injected script cannot read it from storage.
 * - The refresh token is an HttpOnly, SameSite=Strict cookie set by auth-service.
 *   JavaScript cannot read it; the browser sends it only to /api/auth.
 * - On page load the session is restored from that cookie, and the access token is
 *   renewed shortly before it expires. Logout revokes the session on the server.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const token = session?.token ?? null;

  const clear = useCallback(() => setSession(null), []);
  const renew = useCallback(() => {
    api.refresh().then(setSession, clear);
  }, [clear]);

  // Restore an existing session (e.g. after a page reload).
  useEffect(() => {
    let active = true;
    api
      .refresh()
      .then((restored) => {
        if (active) setSession(restored);
      })
      .catch(() => {
        /* no session: stay anonymous */
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    const expiresAt = expiryOf(token);
    if (expiresAt === null) {
      clear();
      return;
    }
    // A token that is already (nearly) expired is renewed immediately.
    const timer = setTimeout(
      renew,
      Math.min(Math.max(expiresAt - Date.now() - RENEW_BEFORE_MS, 0), 2147483647),
    );
    // A 401 for THIS token (e.g. clock skew) gets one renewal attempt; a 401 from an
    // older token that was already replaced is ignored.
    const expired = (event: Event) => {
      if ((event as CustomEvent<string>).detail === token) renew();
    };
    window.addEventListener('auth:expired', expired);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('auth:expired', expired);
    };
  }, [token, renew, clear]);

  const value = useMemo<AuthState>(
    () => ({
      user: session?.user ?? null,
      token,
      ready,
      async login(email, password) {
        setSession(await api.login(email, password));
      },
      async register(email, password) {
        await api.register(email, password);
        // Setelah register, langsung login supaya alur mulus.
        setSession(await api.login(email, password));
      },
      logout() {
        setSession(null);
        // Revoke the refresh token server-side; the UI is already signed out.
        api.logout().catch(() => {});
      },
    }),
    [session, token, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider');
  return ctx;
}
