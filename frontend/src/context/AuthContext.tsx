import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  logout: () => Promise<void>;
  /** New access token from the refresh cookie, e.g. after the email was verified. */
  refresh: () => Promise<void>;
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
 *   JavaScript cannot read it; the browser sends it only to /api/v1/auth.
 * - On page load the session is restored from that cookie, and the access token is
 *   renewed shortly before it expires. Logout revokes the session on the server.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const signingOut = useRef<Promise<void> | null>(null);
  const token = session?.token ?? null;

  const clear = useCallback(() => {
    generation.current += 1;
    setSession(null);
  }, []);
  const refresh = useCallback(async () => {
    if (signingOut.current) return;
    const current = generation.current;
    const restored = await api.refresh();
    if (current === generation.current) setSession(restored);
  }, []);
  const renew = useCallback(() => {
    const current = generation.current;
    refresh().catch(() => {
      if (current === generation.current) clear();
    });
  }, [refresh, clear]);

  // Restore an existing session (e.g. after a page reload).
  useEffect(() => {
    let active = true;
    const current = generation.current;
    api
      .refresh()
      .then((restored) => {
        if (active && current === generation.current) setSession(restored);
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
    // Near an absolute session deadline a renewal also has a short lifetime.
    // Renew halfway through that remaining time instead of creating a tight loop.
    const remaining = expiresAt - Date.now();
    const delay =
      remaining > 0 ? Math.max(250, remaining - Math.min(RENEW_BEFORE_MS, remaining / 2)) : 0;
    const timer = setTimeout(renew, Math.min(delay, 2147483647));
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
        if (signingOut.current) await signingOut.current;
        const current = ++generation.current;
        const next = await api.login(email, password);
        if (current === generation.current) setSession(next);
      },
      async register(email, password) {
        if (signingOut.current) await signingOut.current;
        const current = ++generation.current;
        await api.register(email, password);
        // Setelah register, langsung login supaya alur mulus.
        const next = await api.login(email, password);
        if (current === generation.current) setSession(next);
      },
      logout() {
        if (signingOut.current) return signingOut.current;
        // Ignore late renewals. A failed server logout remains visible and can be retried.
        generation.current += 1;
        signingOut.current = api
          .logout(token ?? undefined)
          .then(clear)
          .finally(() => {
            signingOut.current = null;
          });
        return signingOut.current;
      },
      refresh,
    }),
    [session, token, ready, refresh, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider');
  return ctx;
}
