import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { api, ApiError } from '../api/client';

function Harness() {
  const auth = useAuth();
  return (
    <>
      <span data-testid="ready">{String(auth.ready)}</span>
      <span data-testid="session">{auth.token ?? 'anonymous'}</span>
      <button onClick={() => void auth.login('user@test.local', 'password')}>Login</button>
      <button onClick={() => void auth.logout().catch(() => {})}>Logout</button>
    </>
  );
}
const token = (seconds: number) =>
  `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
const user = { id: '1', email: 'user@test.local', role: 'user' };
const noSession = () => Promise.reject(new ApiError('Sesi berakhir', 401, 'INVALID_REFRESH'));
const renderAuth = async () => {
  render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
  await act(async () => {});
};
beforeEach(() => {
  vi.spyOn(api, 'logout').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session lifecycle', () => {
  it('restores a session from the refresh cookie after a page reload', async () => {
    const restored = token(900);
    vi.spyOn(api, 'refresh').mockResolvedValue({ token: restored, user });
    await renderAuth();
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(screen.getByTestId('session')).toHaveTextContent(restored);
  });

  it('stays anonymous, but ready, when there is no session cookie', async () => {
    vi.spyOn(api, 'refresh').mockImplementation(noSession);
    await renderAuth();
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(screen.getByTestId('session')).toHaveTextContent('anonymous');
  });

  it('renews the access token shortly before it expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = token(120);
    const second = token(900);
    vi.spyOn(api, 'refresh')
      .mockImplementationOnce(noSession)
      .mockResolvedValueOnce({ token: second, user });
    vi.spyOn(api, 'login').mockResolvedValue({ token: first, user });
    await renderAuth();
    await act(async () => {
      fireEvent.click(screen.getByText('Login'));
    });
    expect(screen.getByTestId('session')).toHaveTextContent(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000); // 120 s token, renewed 60 s early
    });
    expect(screen.getByTestId('session')).toHaveTextContent(second);
  });

  it('signs out when an expired token cannot be renewed', async () => {
    vi.spyOn(api, 'refresh').mockImplementation(noSession);
    vi.spyOn(api, 'login').mockResolvedValue({ token: token(-1), user });
    await renderAuth();
    await act(async () => {
      fireEvent.click(screen.getByText('Login'));
    });
    // An expired token is renewed on the next tick; let that attempt fail.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByTestId('session')).toHaveTextContent('anonymous');
  });

  it('does not flood refresh when the absolute session deadline is near', async () => {
    vi.useFakeTimers();
    const short = token(30);
    vi.spyOn(api, 'refresh').mockResolvedValue({ token: short, user, expiresIn: 30 });
    await renderAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(api.refresh).toHaveBeenCalledTimes(2);
  });

  it('handles 401 expiry only for the current session', async () => {
    const current = token(3600);
    vi.spyOn(api, 'refresh').mockImplementation(noSession);
    vi.spyOn(api, 'login').mockResolvedValue({ token: current, user });
    await renderAuth();
    await act(async () => {
      fireEvent.click(screen.getByText('Login'));
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: 'old-token' }));
    });
    expect(screen.getByTestId('session')).toHaveTextContent(current);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: current }));
    });
    expect(screen.getByTestId('session')).toHaveTextContent('anonymous');
  });

  it('revokes the session on the server when signing out', async () => {
    vi.spyOn(api, 'refresh').mockResolvedValue({ token: token(900), user });
    await renderAuth();
    await act(async () => {
      fireEvent.click(screen.getByText('Logout'));
    });
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('session')).toHaveTextContent('anonymous');
  });

  it('does not restore a session when a renewal finishes after logout', async () => {
    const current = token(3600);
    let complete!: (session: { token: string; user: typeof user }) => void;
    vi.spyOn(api, 'refresh')
      .mockResolvedValueOnce({ token: current, user })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    await renderAuth();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: current }));
      fireEvent.click(screen.getByText('Logout'));
    });
    await act(async () => {
      complete({ token: token(900), user });
    });
    expect(screen.getByTestId('session')).toHaveTextContent('anonymous');
  });

  it('keeps the session available to retry when server logout fails', async () => {
    const current = token(900);
    vi.spyOn(api, 'refresh').mockResolvedValue({ token: current, user });
    vi.mocked(api.logout).mockRejectedValueOnce(new ApiError('Tidak dapat menghubungi server', 0));
    await renderAuth();
    await act(async () => {
      fireEvent.click(screen.getByText('Logout'));
    });
    expect(screen.getByTestId('session')).toHaveTextContent(current);
    await act(async () => {
      fireEvent.click(screen.getByText('Logout'));
    });
    expect(api.logout).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('session')).toHaveTextContent('anonymous');
  });
});
