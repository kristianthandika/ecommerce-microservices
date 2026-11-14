import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import logo from '../assets/brand/logo.png';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';

type State =
  | { phase: 'working' }
  | { phase: 'done'; email: string; differentAccount: boolean; sessionRefreshFailed: boolean }
  | { phase: 'failed'; message: string };

/**
 * Landing page of the verification link. The token travels in the URL fragment
 * (`#token=…`), which the browser never sends to a server, and is removed from the
 * address bar as soon as it has been read.
 */
export function VerifyEmailPage() {
  const { refresh, user, ready } = useAuth();
  const [state, setState] = useState<State>({ phase: 'working' });
  const started = useRef(false);

  useEffect(() => {
    // The token is single-use: StrictMode runs effects twice, the request must not.
    if (started.current || !ready) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (!token) {
      setState({ phase: 'failed', message: 'Tautan verifikasi tidak lengkap.' });
      return;
    }
    api
      .verifyEmail(token)
      .then(async ({ user: verified }) => {
        // A signed-in session gets a new access token that carries the verified status.
        let sessionRefreshFailed = false;
        if (user?.id === verified.id)
          await refresh().catch(() => {
            sessionRefreshFailed = true;
          });
        setState({
          phase: 'done',
          email: verified.email,
          differentAccount: !!user && user.id !== verified.id,
          sessionRefreshFailed,
        });
      })
      .catch((err: unknown) =>
        setState({
          phase: 'failed',
          message: err instanceof ApiError ? err.message : 'Verifikasi gagal. Coba lagi.',
        }),
      );
  }, [refresh, ready, user]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
        <img src={logo} alt="Inixindo Bandung" className="h-12 mx-auto mb-6" />
        <h1 className="text-2xl font-semibold text-primary">Verifikasi email</h1>
        {state.phase === 'working' && (
          <p role="status" className="text-muted mt-4">
            Memverifikasi...
          </p>
        )}
        {state.phase === 'done' && (
          <>
            <p role="status" className="mt-4">
              Email <strong className="break-all">{state.email}</strong> sudah terverifikasi.
              {state.differentAccount
                ? ' Anda sedang masuk dengan akun lain; keluar lalu masuk dengan akun yang baru diverifikasi untuk membuat pesanan.'
                : state.sessionRefreshFailed
                  ? ' Sesi belum berhasil diperbarui. Masuk kembali agar status verifikasi terbaca sebelum membuat pesanan.'
                  : ' Masuk dengan akun tersebut untuk membuat pesanan.'}
            </p>
            <Link
              className="button-primary inline-flex mt-6"
              to={state.sessionRefreshFailed ? '/login' : '/dashboard'}
            >
              {state.sessionRefreshFailed ? 'Masuk kembali' : 'Lanjut belanja'}
            </Link>
          </>
        )}
        {state.phase === 'failed' && (
          <>
            <p role="alert" className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2 mt-4">
              {state.message}
            </p>
            <p className="text-sm text-muted mt-4">
              Jika email Anda sudah terverifikasi, lanjutkan belanja. Jika belum, masuk lalu minta
              tautan baru dari pemberitahuan di bagian atas halaman.
            </p>
            <Link className="button-secondary inline-flex mt-6" to="/dashboard">
              Buka toko
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
