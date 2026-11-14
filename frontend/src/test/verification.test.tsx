import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client';
import { EmailVerificationNotice } from '../components/EmailVerificationNotice';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { CheckoutPage } from '../pages/CheckoutPage';
import { OutboxPage } from '../pages/OutboxPage';
import { Header } from '../components/Header';

const auth = vi.hoisted(() => ({
  current: {
    token: 'test-token' as string | null,
    user: { id: 'u1', email: 'new@test.local', role: 'user', emailVerified: false } as {
      id: string;
      email: string;
      role: string;
      emailVerified?: boolean;
    } | null,
    ready: true,
    logout: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.current }));
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
const setVerified = (emailVerified: boolean | undefined) => {
  auth.current = { ...auth.current, user: { ...auth.current.user!, emailVerified } };
};
afterEach(() => {
  vi.restoreAllMocks();
  auth.current.refresh.mockClear();
  auth.current.logout.mockReset();
  setVerified(false);
  window.history.replaceState(null, '', '/');
});

describe('unverified accounts', () => {
  it('are told why they cannot order yet and can ask for a new mail', async () => {
    const resend = vi.spyOn(api, 'resendVerification').mockResolvedValue({ sent: true });
    render(<EmailVerificationNotice />);
    expect(screen.getByText('Email belum diverifikasi.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Kirim ulang email' }));
    });
    expect(resend).toHaveBeenCalledWith('test-token');
    expect(screen.getByRole('status')).toHaveTextContent('dikirim ke new@test.local');
  });

  it('see the server explanation when resending is throttled', async () => {
    vi.spyOn(api, 'resendVerification').mockRejectedValue(
      new ApiError('Email verifikasi baru saja dikirim.', 429, 'VERIFICATION_THROTTLED'),
    );
    render(<EmailVerificationNotice />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Kirim ulang email' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('baru saja dikirim');
  });

  it('get no notice once verified, nor do accounts from before verification existed', () => {
    setVerified(true);
    const { container, rerender } = render(<EmailVerificationNotice />);
    expect(container).toBeEmptyDOMElement();
    setVerified(undefined);
    rerender(<EmailVerificationNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('cannot submit a checkout the server would refuse', () => {
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
  const open = () =>
    render(
      <StrictMode>
        <MemoryRouter>
          <VerifyEmailPage />
        </MemoryRouter>
      </StrictMode>,
    );

  it('sends the fragment token once, removes it from the address bar and renews the session', async () => {
    window.history.replaceState(null, '', '/verify-email#token=abc_DEF-123');
    const verify = vi.spyOn(api, 'verifyEmail').mockResolvedValue({
      user: { id: 'u1', email: 'new@test.local', role: 'user', emailVerified: true },
    });
    await act(async () => {
      open();
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('abc_DEF-123');
    expect(window.location.hash).toBe('');
    expect(auth.current.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('sudah terverifikasi');
  });

  it('explains a used or expired link without claiming success', async () => {
    window.history.replaceState(null, '', '/verify-email#token=used');
    vi.spyOn(api, 'verifyEmail').mockRejectedValue(
      new ApiError('Tautan verifikasi tidak berlaku', 400, 'INVALID_VERIFICATION_TOKEN'),
    );
    await act(async () => {
      open();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('tidak berlaku');
    expect(auth.current.refresh).not.toHaveBeenCalled();
  });

  it('identifies the verified address when another account opens its link', async () => {
    window.history.replaceState(null, '', '/verify-email#token=another-account');
    vi.spyOn(api, 'verifyEmail').mockResolvedValue({
      user: { id: 'u2', email: 'other@test.local', role: 'user', emailVerified: true },
    });
    await act(async () => {
      open();
    });
    expect(auth.current.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('other@test.local');
    expect(screen.getByRole('status')).toHaveTextContent('akun lain');
  });

  it('offers a new login when verification succeeds but updating the session fails', async () => {
    window.history.replaceState(null, '', '/verify-email#token=valid');
    vi.spyOn(api, 'verifyEmail').mockResolvedValue({
      user: { id: 'u1', email: 'new@test.local', role: 'user', emailVerified: true },
    });
    auth.current.refresh.mockRejectedValueOnce(new ApiError('Koneksi terputus', 0));
    await act(async () => {
      open();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Sesi belum berhasil diperbarui');
    expect(screen.getByRole('link', { name: 'Masuk kembali' })).toHaveAttribute('href', '/login');
  });

  it('does not call the API when the link carries no token', async () => {
    const verify = vi.spyOn(api, 'verifyEmail');
    await act(async () => {
      open();
    });
    expect(verify).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('tidak lengkap');
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
  it('removes previously loaded verification links when the mailbox is disabled', async () => {
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Muat ulang' }));
    });
    expect(screen.queryByRole('link', { name: 'Buka tautan verifikasi' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('tidak aktif');
  });
});
