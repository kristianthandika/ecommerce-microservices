import { useEffect, useState, type ReactNode } from 'react';
import logo from '../assets/brand/logo.png';

/** Centered card shared by the pages that work without a session. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <img src={logo} alt="Inixindo Bandung" className="h-12 mx-auto mb-6" />
        <h1 className="text-2xl font-semibold text-primary text-center">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function TextField({
  label,
  type,
  value,
  onChange,
  name,
  autoComplete,
  minLength,
}: {
  label: string;
  type: 'email' | 'password';
  value: string;
  onChange: (value: string) => void;
  name: string;
  // Memberi tahu browser/password manager isi field ini (WCAG 1.3.5).
  autoComplete: string;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink">{label}</span>
      <input
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        minLength={minLength}
        autoComplete={autoComplete}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-secondary focus:ring-1 focus:ring-secondary outline-none"
      />
    </label>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">
      {children}
    </p>
  );
}

export const submitClass =
  'w-full rounded-lg bg-primary hover:bg-primary-hover text-white font-medium py-2.5 transition-colors disabled:opacity-60';

/**
 * Token of a mailed link. It travels in the URL fragment (`#token=…`), which the
 * browser never sends to a server, and is removed from the address bar as soon as
 * it has been read, so it does not linger in the history or get copied by accident.
 */
export function useFragmentToken(): string | null {
  // Read during the first render; the effect below must not run before that.
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  useEffect(() => {
    if (window.location.hash)
      window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);
  return token;
}
