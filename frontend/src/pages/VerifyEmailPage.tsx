import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  AuthCard,
  FormError,
  TextField,
  submitClass,
  useFragmentToken,
} from '../components/AuthCard';

type State =
  | { phase: 'form'; error: string }
  | { phase: 'verified'; email: string }
  | { phase: 'failed'; message: string };

/**
 * Landing page of the verification link. Activating an account takes the link AND
 * the password chosen at registration: whoever merely receives the mail cannot
 * activate an account that somebody else registered with their address.
 */
export function VerifyEmailPage() {
  const { login, logout, user } = useAuth();
  const navigate = useNavigate();
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<State>(
    token
      ? { phase: 'form', error: '' }
      : { phase: 'failed', message: 'Tautan verifikasi tidak lengkap.' },
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    let email: string;
    try {
      email = (await api.verifyEmail(token, password)).user.email;
    } catch (err) {
      // A wrong password leaves the link usable; anything else means it is void.
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS')
        setState({ phase: 'form', error: err.message });
      else
        setState({
          phase: 'failed',
          message: err instanceof ApiError ? err.message : 'Verifikasi gagal. Coba lagi.',
        });
      setBusy(false);
      return;
    }
    try {
      // Another account may be signed in in this browser; the new one replaces it.
      if (user && user.email !== email) await logout();
      await login(email, password);
      void navigate('/dashboard');
    } catch {
      // The account is active either way; signing in can be done by hand.
      setState({ phase: 'verified', email });
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Verifikasi email">
      {state.phase === 'form' && (
        <>
          <p className="text-sm text-muted text-center mt-1 mb-6">
            Masukkan password yang Anda pilih saat mendaftar untuk mengaktifkan akun.
          </p>
          <form onSubmit={onSubmit} className="space-y-4" aria-label="form-verify-email">
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              name="password"
              autoComplete="current-password"
              minLength={8}
            />
            {state.error && <FormError>{state.error}</FormError>}
            <button type="submit" disabled={busy} className={submitClass}>
              {busy ? 'Memproses…' : 'Aktifkan akun'}
            </button>
          </form>
          <p className="text-sm text-muted text-center mt-6">
            Bukan Anda yang mendaftar? Abaikan saja; tanpa password, akun ini tidak pernah aktif.
          </p>
        </>
      )}
      {state.phase === 'verified' && (
        <div className="text-center">
          <p role="status" className="mt-4">
            Email <strong className="break-all">{state.email}</strong> sudah terverifikasi. Silakan
            masuk.
          </p>
          <Link className="button-primary inline-flex mt-6" to="/login">
            Masuk
          </Link>
        </div>
      )}
      {state.phase === 'failed' && (
        <div className="text-center">
          <p role="alert" className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2 mt-4">
            {state.message}
          </p>
          <p className="text-sm text-muted mt-4">
            Jika akun Anda sudah aktif, silakan masuk. Jika belum, daftar ulang dengan alamat yang
            sama untuk mendapat tautan baru.
          </p>
          <div className="flex justify-center gap-2 mt-6">
            <Link className="button-secondary inline-flex" to="/login">
              Masuk
            </Link>
            <Link className="button-secondary inline-flex" to="/register">
              Daftar ulang
            </Link>
          </div>
        </div>
      )}
    </AuthCard>
  );
}
