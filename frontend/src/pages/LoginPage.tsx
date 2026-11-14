import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import logo from '../assets/brand/logo.png';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../api/client';

export function LoginPage() {
  const { login, user, ready } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      void navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal login');
    } finally {
      setLoading(false);
    }
  }

  // A restored session (refresh cookie) goes straight to the app.
  if (ready && user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <img src={logo} alt="Inixindo Bandung" className="h-12 mx-auto mb-6" />
        <h1 className="text-2xl font-semibold text-primary text-center">Masuk</h1>
        <p className="text-sm text-muted text-center mt-1 mb-6">
          Dashboard E-Commerce Microservices
        </p>

        <form onSubmit={onSubmit} className="space-y-4" aria-label="form-login">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            name="email"
            autoComplete="username"
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            name="password"
            autoComplete="current-password"
          />

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
            {loading ? 'Memproses…' : 'Masuk'}
          </button>
        </form>

        <p className="text-sm text-muted text-center mt-6">
          <Link to="/forgot-password" className="text-secondary font-medium hover:underline">
            Lupa password?
          </Link>
        </p>
        <p className="text-sm text-muted text-center mt-2">
          Belum punya akun?{' '}
          <Link to="/register" className="text-secondary font-medium hover:underline">
            Daftar
          </Link>
        </p>
        <p className="text-xs text-muted text-center mt-4">
          Baru mendaftar? Aktifkan akun lewat tautan di email sebelum masuk.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  name,
  autoComplete,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  name: string;
  // Memberi tahu browser/password manager isi field ini (WCAG 1.3.5).
  autoComplete: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink">{label}</span>
      <input
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        autoComplete={autoComplete}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-secondary focus:ring-1 focus:ring-secondary outline-none"
      />
    </label>
  );
}
