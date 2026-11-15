import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { RegisterPage } from '../pages/RegisterPage';
import { ForgotPasswordPage } from '../pages/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
import { CheckoutPage } from '../pages/CheckoutPage';
import { OutboxPage } from '../pages/OutboxPage';
import { Header } from '../components/Header';

type TestUser = { id: string; email: string; role: string; emailVerified?: boolean };
const signedIn: TestUser = { id: 'u1', email: 'new@test.local', role: 'user', emailVerified: true };
const auth = vi.hoisted(() => ({
  current: {
    token: 'test-token' as string | null,
    user: null as { id: string; email: string; role: string; emailVerified?: boolean } | null,
    ready: true,
    login: vi.fn(async () => {}),
    register: vi.fn(async () => ({ verificationRequired: true })),
    logout: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  },
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.current }));
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('../context/CartContext', () => ({
  useCart: () => ({
    cart: {
      version: 'cart-version',
      items: [
        {
          productId: 'p1',
          name: 'Mug',
          unitPrice: 100,
          subtotal: 100,
          quantity: 1,
          stock: 5,
          available: true,
        },
      ],
      quantity: 1,
      total: 100,
      canCheckout: true,
    },
    reload: async () => null,
  }),
}));
const setUser = (user: TestUser | null) => {
  auth.current = { ...auth.current, user, token: user ? 'test-token' : null };
};
setUser(signedIn);
afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [auth.current.login, auth.current.logout, auth.current.refresh])
    mock.mockReset();
  auth.current.register.mockReset().mockResolvedValue({ verificationRequired: true });
  navigate.mockReset();
  setUser(signedIn);
  window.history.replaceState(null, '', '/');
});

const page = (element: React.ReactNode) =>
  render(
    <StrictMode>
      <MemoryRouter>{element}</MemoryRouter>
    </StrictMode>,
  );
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

describe('registration', () => {
  it('asks the user to check their mail and never says whether the address was taken', async () => {
    setUser(null);
    page(<RegisterPage />);
    type('Email', 'new@test.local');
    type('Password', 'correct-horse-battery');
    await submit('Daftar');
    expect(auth.current.register).toHaveBeenCalledWith('new@test.local', 'correct-horse-battery');
    expect(screen.getByRole('status')).toHaveTextContent('Periksa kotak masuk new@test.local');
    expect(screen.getByRole('link', { name: 'Atur ulang password' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    // Nobody is signed in until the mailed link was used.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Daftar' })).not.toBeInTheDocument();
  });

  it('goes straight to the shop when the server does not require verification', async () => {
    setUser(null);
    auth.current.register.mockResolvedValue({ verificationRequired: false });
    page(<RegisterPage />);
    type('Email', 'dev@test.local');
    type('Password', 'correct-horse-battery');
    await submit('Daftar');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });
});

describe('accounts from before verification was required', () => {
  it('cannot submit a checkout the server would refuse', () => {
    setUser({ ...signedIn, emailVerified: false });
    const checkout = vi.spyOn(api, 'checkout');
    render(
      <MemoryRouter>
        <CheckoutPage />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'Konfirmasi pesanan' });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form')!);
    expect(checkout).not.toHaveBeenCalled();
  });
});

describe('verification link', () => {
  const verified = { user: { id: 'u9', email: 'fresh@test.local', role: 'user' } };

  it('takes the fragment token out of the address bar and activates with the password, then signs in', async () => {
    setUser(null);
    window.history.replaceState(null, '', '/verify-email#token=abc_DEF-123');
    const verify = vi.spyOn(api, 'verifyEmail').mockResolvedValue(verified);
    page(<VerifyEmailPage />);
    expect(window.location.hash).toBe('');
    // Opening the link alone does nothing.
    expect(verify).not.toHaveBeenCalled();
    type('Password', 'correct-horse-battery');
    await submit('Aktifkan akun');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('abc_DEF-123', 'correct-horse-battery');
    expect(auth.current.login).toHaveBeenCalledWith('fresh@test.local', 'correct-horse-battery');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('keeps the form after a wrong password so the user can try again', async () => {
    setUser(null);
    window.history.replaceState(null, '', '/verify-email#token=valid');
    const verify = vi
      .spyOn(api, 'verifyEmail')
      .mockRejectedValueOnce(new ApiError('Password salah', 401, 'INVALID_CREDENTIALS'))
      .mockResolvedValueOnce(verified);
    page(<VerifyEmailPage />);
    type('Password', 'wrong-password');
    await submit('Aktifkan akun');
    expect(screen.getByRole('alert')).toHaveTextContent('Password salah');
    expect(auth.current.login).not.toHaveBeenCalled();
    type('Password', 'correct-horse-battery');
    await submit('Aktifkan akun');
    expect(verify).toHaveBeenLastCalledWith('valid', 'correct-horse-battery');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('explains a used or expired link without claiming success', async () => {
    setUser(null);
    window.history.replaceState(null, '', '/verify-email#token=used');
    vi.spyOn(api, 'verifyEmail').mockRejectedValue(
      new ApiError('Tautan verifikasi tidak berlaku', 400, 'INVALID_VERIFICATION_TOKEN'),
    );
    page(<VerifyEmailPage />);
    type('Password', 'correct-horse-battery');
    await submit('Aktifkan akun');
    expect(screen.getByRole('alert')).toHaveTextContent('tidak berlaku');
    expect(screen.getByRole('link', { name: 'Daftar ulang' })).toHaveAttribute('href', '/register');
    expect(auth.current.login).not.toHaveBeenCalled();
  });

  it('signs another account out before signing the verified one in', async () => {
    window.history.replaceState(null, '', '/verify-email#token=another-account');
    vi.spyOn(api, 'verifyEmail').mockResolvedValue(verified);
    page(<VerifyEmailPage />);
    type('Password', 'correct-horse-battery');
    await submit('Aktifkan akun');
    expect(auth.current.logout).toHaveBeenCalledTimes(1);
    expect(auth.current.login).toHaveBeenCalledWith('fresh@test.local', 'correct-horse-battery');
  });

  it('offers the login page when the account is active but signing in failed', async () => {
    setUser(null);
    window.history.replaceState(null, '', '/verify-email#token=valid');
    vi.spyOn(api, 'verifyEmail').mockResolvedValue(verified);
    auth.current.login.mockRejectedValueOnce(new ApiError('Koneksi terputus', 0));
    page(<VerifyEmailPage />);
    type('Password', 'correct-horse-battery');
    await submit('Aktifkan akun');
    expect(screen.getByRole('status')).toHaveTextContent('fresh@test.local sudah terverifikasi');
    expect(screen.getByRole('link', { name: 'Masuk' })).toHaveAttribute('href', '/login');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not offer a form when the link carries no token', () => {
    const verify = vi.spyOn(api, 'verifyEmail');
    page(<VerifyEmailPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('tidak lengkap');
    expect(screen.queryByRole('button', { name: 'Aktifkan akun' })).not.toBeInTheDocument();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('password reset', () => {
  it('gives the same answer for every address when a link is requested', async () => {
    setUser(null);
    const request = vi.spyOn(api, 'requestPasswordReset').mockResolvedValue({ status: 'accepted' });
    page(<ForgotPasswordPage />);
    type('Email', 'someone@test.local');
    await submit('Kirim tautan');
    expect(request).toHaveBeenCalledWith('someone@test.local');
    expect(screen.getByRole('status')).toHaveTextContent('Jika someone@test.local punya akun');
  });

  it('shows why a request could not be sent', async () => {
    setUser(null);
    vi.spyOn(api, 'requestPasswordReset').mockRejectedValue(
      new ApiError('Terlalu banyak percobaan autentikasi', 429, 'RATE_LIMITED'),
    );
    page(<ForgotPasswordPage />);
    type('Email', 'someone@test.local');
    await submit('Kirim tautan');
    expect(screen.getByRole('alert')).toHaveTextContent('Terlalu banyak percobaan');
  });

  it('sets the new password from the link, then signs in with it', async () => {
    setUser(null);
    window.history.replaceState(null, '', '/reset-password#token=reset_TOKEN-1');
    const confirm = vi.spyOn(api, 'confirmPasswordReset').mockResolvedValue({
      user: { id: 'u1', email: 'new@test.local', role: 'user' },
    });
    page(<ResetPasswordPage />);
    expect(window.location.hash).toBe('');
    type('Password baru', 'a-brand-new-password');
    type('Ulangi password baru', 'a-different-password');
    await submit('Simpan password');
    expect(screen.getByRole('alert')).toHaveTextContent('tidak sama');
    expect(confirm).not.toHaveBeenCalled();

    type('Ulangi password baru', 'a-brand-new-password');
    await submit('Simpan password');
    expect(confirm).toHaveBeenCalledWith('reset_TOKEN-1', 'a-brand-new-password');
    expect(auth.current.login).toHaveBeenCalledWith('new@test.local', 'a-brand-new-password');
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('sends the user to request a new link when this one is void', async () => {
    setUser(null);
    window.history.replaceState(null, '', '/reset-password#token=expired');
    vi.spyOn(api, 'confirmPasswordReset').mockRejectedValue(
      new ApiError('Tautan atur ulang password tidak berlaku', 400, 'INVALID_RESET_TOKEN'),
    );
    page(<ResetPasswordPage />);
    type('Password baru', 'a-brand-new-password');
    type('Ulangi password baru', 'a-brand-new-password');
    await submit('Simpan password');
    expect(screen.getByRole('alert')).toHaveTextContent('tidak berlaku');
    expect(screen.getByRole('link', { name: 'Minta tautan baru' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});

it('makes a failed server logout visible and allows the user to retry', async () => {
  auth.current.logout.mockRejectedValueOnce(new ApiError('Koneksi terputus', 0));
  render(
    <MemoryRouter>
      <Header />
    </MemoryRouter>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Keluar' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Sesi belum berhasil ditutup di server');
  expect(screen.getByRole('button', { name: 'Keluar' })).toBeEnabled();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Keluar' }));
  });
  expect(auth.current.logout).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

describe('training mailbox', () => {
  it('removes previously loaded links when the mailbox is disabled', async () => {
    vi.spyOn(api, 'outbox')
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'm1',
            to: 'new@test.local',
            subject: 'Verifikasi',
            text: 'Email pelatihan',
            createdAt: '2026-11-14T00:00:00.000Z',
            link: 'http://localhost:3000/verify-email#token=once',
          },
          {
            id: 'm2',
            to: 'new@test.local',
            subject: 'Atur ulang password',
            text: 'Email pelatihan',
            createdAt: '2026-11-14T00:01:00.000Z',
            link: 'http://localhost:3000/reset-password#token=once',
          },
        ],
      })
      .mockRejectedValueOnce(new ApiError('Tidak ditemukan', 404));
    await act(async () => {
      render(
        <MemoryRouter>
          <OutboxPage />
        </MemoryRouter>,
      );
    });
    expect(screen.getByRole('link', { name: 'Buka tautan verifikasi' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Buka tautan atur ulang password' }),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Muat ulang' }));
    });
    expect(screen.queryByRole('link', { name: 'Buka tautan verifikasi' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('tidak aktif');
  });
});
