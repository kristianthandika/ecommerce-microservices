import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * Shown to signed-in accounts whose email is not verified yet. They can browse and
 * fill the cart; the server refuses order creation until the address is confirmed.
 */
export function EmailVerificationNotice() {
  const { user, token } = useAuth();
  const [state, setState] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user || !token || user.emailVerified !== false) return null;

  async function resend() {
    if (!token || busy) return;
    setBusy(true);
    try {
      await api.resendVerification(token);
      setState({ text: `Email verifikasi dikirim ke ${user?.email}.`, error: false });
    } catch (err) {
      setState({
        text: err instanceof ApiError ? err.message : 'Email verifikasi gagal dikirim',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      aria-label="Verifikasi email"
      className="rounded-xl px-4 py-3 text-sm mb-5 bg-amber-50 text-amber-900 border border-amber-200 flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <p className="flex-1 min-w-0">
        <strong>Email belum diverifikasi.</strong> Buka tautan yang kami kirim ke{' '}
        <span className="break-all">{user.email}</span> sebelum membuat pesanan.
      </p>
      <button className="button-secondary" onClick={resend} disabled={busy}>
        {busy ? 'Mengirim...' : 'Kirim ulang email'}
      </button>
      {state && (
        <p role={state.error ? 'alert' : 'status'} className="w-full">
          {state.text}
        </p>
      )}
    </aside>
  );
}
