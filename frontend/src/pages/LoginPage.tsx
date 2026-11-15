import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import logo from '../assets/brand/logo.png';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../api/client';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('admin@inixindo.local');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal login');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <img src={logo} alt="Inixindo Bandung" className="h-12 mx-auto mb-6" />
        <h1 className="text-2xl font-semibold text-primary text-center">Masuk</h1>
        <p className="text-sm text-muted text-center mt-1 mb-6">
          Dashboard E-Commerce Microservices
        </p>

        <form onSubmit={onSubmit} className="space-y-4" aria-label="form-login">
          <Field label="Email" type="email" value={email} onChange={setEmail} name="email" />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            name="password"
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
          Belum punya akun?{' '}
          <Link to="/register" className="text-secondary font-medium hover:underline">
            Daftar
          </Link>
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
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  name: string;
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
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-secondary focus:ring-1 focus:ring-secondary outline-none"
      />
    </label>
  );
}
