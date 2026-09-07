// Base URL API dibaca dari VITE_API_BASE_URL. PENTING: nilai ini di-BAKE ke
// bundle saat `npm run build`, BUKAN dibaca saat runtime container (lihat m4.1
// & Dockerfile frontend). Default localhost untuk dev.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

export interface User {
  id: string;
  email: string;
  role: string;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
}

export type ServiceStatus = 'up' | 'down';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  gateway: string;
  services: Record<string, ServiceStatus>;
  timestamp: string;
}

/** Error API dengan bentuk SERAGAM, apa pun service asalnya. */
export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = opts;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Gateway/jaringan tidak terjangkau.
    throw new ApiError('Tidak dapat menghubungi server', 0, 'NETWORK');
  }

  const text = await res.text();
  // Body mungkin BUKAN JSON (mis. proxy 502/504 dengan body HTML/teks saat
  // backend tak terjangkau). Jangan biarkan JSON.parse melempar SyntaxError
  // yang lolos dari normalisasi error di bawah.
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    // Normalisasi: service berbeda bisa punya bentuk error berbeda, tapi kita
    // selalu memakai { error: { message, code, details } }.
    const err = ((data as { error?: { message?: string; code?: string; details?: unknown } } | null)
      ?.error) ?? {};
    throw new ApiError(
      err.message || res.statusText || 'Terjadi kesalahan',
      res.status,
      err.code,
      err.details,
    );
  }
  return data as T;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ user: User }>('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  me: (token: string) => request<{ user: User }>('/auth/me', { token }),
  products: () => request<{ products: Product[] }>('/products'),
  createOrder: (items: { productId: string; quantity: number }[], token: string) =>
    request<{ order: unknown }>('/orders', { method: 'POST', body: { items }, token }),

  /** Health tidak melempar saat 503 (degraded) — widget butuh body-nya. */
  async health(): Promise<HealthResponse> {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      return (await res.json()) as HealthResponse;
    } catch {
      return {
        status: 'degraded',
        gateway: 'down',
        services: {},
        timestamp: new Date().toISOString(),
      };
    }
  },
};
