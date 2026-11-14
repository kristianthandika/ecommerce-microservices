// Base URL API dibaca dari VITE_API_BASE_URL. PENTING: nilai ini di-BAKE ke
// bundle saat `npm run build`, BUKAN dibaca saat runtime container (lihat m4.1
// & Dockerfile frontend). Default same-origin /api/v1; Vite proxies /api during development.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

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
  revision?: number;
}

export interface ShippingAddress {
  recipient: string;
  phone: string;
  street: string;
  city: string;
  province: string;
  postalCode: string;
  notes: string;
}
export interface OrderLine {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}
export interface Order {
  id: string;
  userId: string;
  items: OrderLine[];
  total: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt?: string;
  shippingAddress?: ShippingAddress;
  cartVersion?: string;
  fulfillmentStatus: 'NEW' | 'PROCESSING' | 'COMPLETED';
  cancelledBy?: 'customer' | 'admin';
  cancelReason?: string;
  cancelledAt?: string;
}
export type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLATION_REQUESTED' | 'CANCELLED';
export interface Session {
  token: string;
  user: User;
  expiresIn?: number;
}
export interface CartLine extends OrderLine {
  stock: number;
  available: boolean;
}
export interface Cart {
  version: string;
  items: CartLine[];
  total: number;
  quantity: number;
  canCheckout: boolean;
  updatedAt: string;
}
export interface OrderPage {
  orders: Order[];
  total: number;
  offset: number;
  limit: number;
  /** Keyset cursor for the next page (`?cursor=`); null on the last page. */
  nextCursor: string | null;
}
export interface OrderSummary {
  totalOrders: number;
  confirmedOrders: number;
  pendingOrders: number;
  failedOrders: number;
  cancelledOrders: number;
  confirmedValue: number;
  processingOrders: number;
}
export interface ProductSummary {
  totalProducts: number;
  lowStock: number;
  outOfStock: number;
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

// A custom header forces a CORS preflight for other origins (CSRF defense for the
// cookie-based session endpoints).
const SESSION_HEADER = { 'x-requested-with': 'fetch' };
let refreshing: Promise<Session> | null = null;

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  /** Cart version for optimistic concurrency, sent as `If-Match: "<version>"`. */
  ifMatch?: string;
  headers?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = opts;
  // `content-type` hanya dikirim bila memang ada body: GET/DELETE tanpa body yang
  // mengaku JSON bisa ditolak proxy/parser yang ketat ("empty JSON body").
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.ifMatch) headers['if-match'] = `"${opts.ifMatch}"`;
  Object.assign(headers, opts.headers);

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      signal: AbortSignal.timeout(12000),
      // Same-origin only: the HttpOnly refresh cookie never leaves this site.
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch {
    // Gateway/jaringan tidak terjangkau.
    throw new ApiError('Tidak dapat menghubungi server', 0, 'NETWORK');
  }

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
    if (res.status === 401 && token)
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: token }));
    // Normalisasi: service berbeda bisa punya bentuk error berbeda, tapi kita
    // selalu memakai { error: { message, code, details } }.
    const err =
      (data as { error?: { message?: string; code?: string; details?: unknown } } | null)?.error ??
      {};
    throw new ApiError(
      err.message || res.statusText || 'Terjadi kesalahan',
      res.status,
      err.code,
      err.details,
    );
  }
  if (data === null && res.status !== 204)
    throw new ApiError('Respons server tidak valid', 502, 'INVALID_RESPONSE');
  return data as T;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ user: User }>('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email: string, password: string) =>
    request<Session>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  /**
   * New access token from the HttpOnly refresh cookie. Concurrent callers (StrictMode,
   * timers, several 401s) share one request, because each refresh rotates the cookie.
   */
  refresh(): Promise<Session> {
    refreshing ??= (async () => {
      try {
        return await request<Session>('/auth/refresh', { method: 'POST', headers: SESSION_HEADER });
      } catch (err) {
        // Another tab rotated the cookie a moment ago; the browser now holds the new one.
        if (!(err instanceof ApiError && err.code === 'REFRESH_RACE')) throw err;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return request<Session>('/auth/refresh', { method: 'POST', headers: SESSION_HEADER });
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },
  logout: () => request<void>('/auth/logout', { method: 'POST', headers: SESSION_HEADER }),
  me: (token: string) => request<{ user: User }>('/auth/me', { token }),
  products: (query = '') =>
    request<{ products: Product[]; total?: number }>(`/products${query ? `?${query}` : ''}`),
  createProduct: (body: Omit<Product, 'id'>, token: string) =>
    request<{ product: Product }>('/products', { method: 'POST', body, token }),
  updateProduct: (
    id: string,
    body: Partial<Omit<Product, 'id'>> & { expectedRevision?: number },
    token: string,
  ) =>
    request<{ product: Product }>(`/products/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body,
      token,
    }),
  deleteProduct: (id: string, token: string) =>
    request<void>(`/products/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
  cart: (token: string) => request<{ cart: Cart }>('/cart', { token }),
  setCartItem: (id: string, quantity: number, version: string, token: string) =>
    request<{ cart: Cart }>(`/cart/items/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { quantity },
      ifMatch: version,
      token,
    }),
  removeCartItem: (id: string, version: string, token: string) =>
    request<{ cart: Cart }>(`/cart/items/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ifMatch: version,
      token,
    }),
  cancelOrder: (id: string, token: string, admin = false, reason = '') =>
    request<{ order: Order }>(`/orders/${admin ? 'admin/' : ''}${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: reason.trim() ? { reason: reason.trim() } : {},
      token,
    }),
  checkout: (
    version: string,
    shippingAddress: ShippingAddress,
    idempotencyKey: string,
    token: string,
  ) =>
    request<{ order: Order }>('/cart/checkout', {
      method: 'POST',
      body: { version, shippingAddress },
      idempotencyKey,
      token,
    }),
  orders: (token: string, query = '') =>
    request<OrderPage>(`/orders${query ? `?${query}` : ''}`, { token }),
  order: (id: string, token: string, admin = false) =>
    request<{ order: Order }>(`/orders/${admin ? 'admin/' : ''}${encodeURIComponent(id)}`, {
      token,
    }),
  adminOrders: (token: string, query = '') =>
    request<OrderPage>(`/orders/admin${query ? `?${query}` : ''}`, { token }),
  orderSummary: (token: string) => request<OrderSummary>('/orders/admin/summary', { token }),
  productSummary: (token: string) => request<ProductSummary>('/products/admin/summary', { token }),
  fulfillOrder: (id: string, status: 'PROCESSING' | 'COMPLETED', token: string) =>
    request<{ order: Order }>(`/orders/admin/${encodeURIComponent(id)}/fulfillment`, {
      method: 'PATCH',
      body: { status },
      token,
    }),
  createOrder: (
    items: { productId: string; quantity: number }[],
    token: string,
    idempotencyKey: string,
  ) =>
    request<{ order: unknown }>('/orders', {
      method: 'POST',
      body: { items },
      token,
      idempotencyKey,
    }),

  /** Health tidak melempar saat 503 (degraded) — widget butuh body-nya. */
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    try {
      const res = await fetch(`${BASE_URL}/health`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
          : AbortSignal.timeout(3000),
      });
      if (![200, 503].includes(res.status)) throw new Error('Invalid health status');
      const body = (await res.json()) as HealthResponse;
      if (
        !['ok', 'degraded'].includes(body.status) ||
        !body.services ||
        !['up', 'down'].includes(body.gateway)
      )
        throw new Error('Invalid health response');
      return body;
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
