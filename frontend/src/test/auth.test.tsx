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
      <button onClick={() => auth.logout()}>Logout</button>
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
});
