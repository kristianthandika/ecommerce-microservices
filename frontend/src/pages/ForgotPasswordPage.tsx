import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { AuthCard, FormError, TextField, submitClass } from '../components/AuthCard';

/**
 * Asks for a password-reset link. The server answers every address the same way, so
 * this page never says whether the address has an account.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await api.requestPasswordReset(email);
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Permintaan gagal dikirim');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Lupa password">
      {sentTo ? (
        <div className="text-center">
          <p role="status" className="mt-4">
            Jika <strong className="break-all">{sentTo}</strong> punya akun, kami mengirim tautan
            untuk mengatur ulang password ke alamat itu. Tautan berlaku 1 jam.
          </p>
          <p className="text-sm text-muted mt-4">
            Tidak menerima email? Periksa folder spam, lalu coba lagi setelah satu menit.
          </p>
          <Link className="button-secondary inline-flex mt-6" to="/login">
            Kembali ke halaman masuk
          </Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted text-center mt-1 mb-6">
            Kami akan mengirim tautan untuk memilih password baru.
          </p>
          <form onSubmit={onSubmit} className="space-y-4" aria-label="form-forgot-password">
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              name="email"
              autoComplete="username"
            />
            {error && <FormError>{error}</FormError>}
            <button type="submit" disabled={busy} className={submitClass}>
              {busy ? 'Memproses…' : 'Kirim tautan'}
            </button>
          </form>
          <p className="text-sm text-muted text-center mt-6">
            Ingat password Anda?{' '}
            <Link to="/login" className="text-secondary font-medium hover:underline">
              Masuk
            </Link>
          </p>
        </>
      )}
    </AuthCard>
  );
}
