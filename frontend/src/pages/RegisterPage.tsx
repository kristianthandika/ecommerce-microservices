import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import logo from '../assets/brand/logo.png';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../api/client';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Address the "check your mail" message refers to, once the request was accepted.
  const [sentTo, setSentTo] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { verificationRequired } = await register(email, password);
      if (verificationRequired) setSentTo(email.trim());
      else void navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal mendaftar');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <img src={logo} alt="Inixindo Bandung" className="h-12 mx-auto mb-6" />
        <h1 className="text-2xl font-semibold text-primary text-center">Daftar Akun</h1>
        {sentTo ? (
          // The same message for every address: the server does not say, and neither
          // do we, whether it already had an account.
          <div className="text-center">
            <p role="status" className="mt-4">
              Periksa kotak masuk <strong className="break-all">{sentTo}</strong> dan ikuti petunjuk
              di email dari kami. Akun baru aktif setelah Anda membuka tautannya dan memasukkan
              password.
            </p>
            <p className="text-sm text-muted mt-4">
              Tidak menerima email? Periksa folder spam, lalu daftar ulang setelah satu menit. Sudah
              punya akun dengan alamat ini?{' '}
              <Link to="/forgot-password" className="text-secondary font-medium hover:underline">
                Atur ulang password
              </Link>
              .
            </p>
            <Link className="button-secondary inline-flex mt-6" to="/login">
              Ke halaman masuk
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted text-center mt-1 mb-6">Password minimal 8 karakter</p>

            <form onSubmit={onSubmit} className="space-y-4" aria-label="form-register">
              <label className="block">
                <span className="text-sm font-medium text-ink">Email</span>
                <input
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-secondary focus:ring-1 focus:ring-secondary outline-none"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-ink">Password</span>
                <input
                  name="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-secondary focus:ring-1 focus:ring-secondary outline-none"
                />
              </label>

              {error && (
                <p role="alert" className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-primary hover:bg-primary-hover text-white font-medium py-2.5 transition-colors disabled:opacity-60"
              >
                {loading ? 'Memproses…' : 'Daftar'}
              </button>
            </form>

            <p className="text-sm text-muted text-center mt-6">
              Sudah punya akun?{' '}
              <Link to="/login" className="text-secondary font-medium hover:underline">
                Masuk
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
