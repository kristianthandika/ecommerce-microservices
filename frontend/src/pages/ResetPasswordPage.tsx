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
  | { phase: 'changed'; email: string }
  | { phase: 'failed'; message: string };

/**
 * Landing page of the password-reset link. The server ends every session of the
 * account when the password changes, so the user signs in again afterwards.
 */
export function ResetPasswordPage() {
  const { login, logout, user } = useAuth();
  const navigate = useNavigate();
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<State>(
    token
      ? { phase: 'form', error: '' }
      : { phase: 'failed', message: 'Tautan atur ulang password tidak lengkap.' },
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || busy) return;
    if (password !== repeat) {
      setState({ phase: 'form', error: 'Kedua password tidak sama.' });
      return;
    }
    setBusy(true);
    let email: string;
    try {
      email = (await api.confirmPasswordReset(token, password)).user.email;
    } catch (err) {
      // Input the server rejects can be corrected; a void link cannot.
      if (err instanceof ApiError && err.code === 'VALIDATION_ERROR')
        setState({ phase: 'form', error: 'Password minimal 8 karakter dan maksimal 72 byte.' });
      else
        setState({
          phase: 'failed',
          message: err instanceof ApiError ? err.message : 'Password gagal diganti. Coba lagi.',
        });
      setBusy(false);
      return;
    }
    try {
      // The session in this browser was ended by the reset (or belongs to somebody else).
      if (user) await logout().catch(() => {});
      await login(email, password);
      void navigate('/dashboard');
    } catch {
      setState({ phase: 'changed', email });
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Atur ulang password">
      {state.phase === 'form' && (
        <>
          <p className="text-sm text-muted text-center mt-1 mb-6">Password minimal 8 karakter</p>
          <form onSubmit={onSubmit} className="space-y-4" aria-label="form-reset-password">
            <TextField
              label="Password baru"
              type="password"
              value={password}
              onChange={setPassword}
              name="password"
              autoComplete="new-password"
              minLength={8}
            />
            <TextField
              label="Ulangi password baru"
              type="password"
              value={repeat}
              onChange={setRepeat}
              name="password-repeat"
              autoComplete="new-password"
              minLength={8}
            />
            {state.error && <FormError>{state.error}</FormError>}
            <button type="submit" disabled={busy} className={submitClass}>
              {busy ? 'Memproses…' : 'Simpan password'}
            </button>
          </form>
        </>
      )}
      {state.phase === 'changed' && (
        <div className="text-center">
          <p role="status" className="mt-4">
            Password <strong className="break-all">{state.email}</strong> sudah diganti. Silakan
            masuk dengan password baru.
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
          <Link className="button-secondary inline-flex mt-6" to="/forgot-password">
            Minta tautan baru
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
