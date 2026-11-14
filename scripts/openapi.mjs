#!/usr/bin/env node
/**
 * Builds the OpenAPI 3.1 description of the public API (everything the gateway
 * exposes under /api/v1) and writes it to services/gateway/openapi.json, which the
 * gateway serves at /api/v1/openapi.json.
 *
 * Request bodies and query parameters are converted from the services' own zod
 * schemas. Refinements that JSON Schema cannot express are described separately;
 * runtime tests remain authoritative for those constraints.
 * Response schemas are declared here and exported for the E2E contract checks.
 *
 *   node scripts/openapi.mjs           # regenerate
 *   node scripts/openapi.mjs --check   # fail if the committed file is out of date (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  credentialsSchema,
  verifyEmailSchema,
  outboxQuerySchema,
} from '../services/auth-service/src/schemas.ts';
import { productSchema, productUpdateSchema } from '../services/product-service/src/schemas.ts';
import * as orderSchemas from '../services/order-service/src/schemas.ts';

export const API_VERSION = '1.0.0';
export const LEGACY_SUNSET = '2027-05-14';
const OUTPUT = fileURLToPath(new URL('../services/gateway/openapi.json', import.meta.url));

// ---------------------------------------------------------------- responses
const id = z.uuid();
const timestamp = z.iso.datetime();
const ErrorBody = z.object({
  error: z.object({
    message: z.string(),
    code: z.string().meta({ description: 'Kode stabil untuk logika klien, mis. CART_CHANGED' }),
    details: z.unknown().optional(),
  }),
});
const User = z.object({
  id,
  email: z.email(),
  role: z.enum(['user', 'admin']),
  emailVerified: z
    .boolean()
    .meta({ description: 'false: akun belum boleh membuat pesanan (klaim JWT email_verified)' }),
});
const OutboxMessage = z.object({
  id,
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  link: z.string().optional().meta({ description: 'Tautan aksi di dalam email' }),
  createdAt: timestamp,
});
const Session = z.object({
  token: z.string().meta({ description: 'Access token JWT RS256' }),
  user: User,
  expiresIn: z.int().meta({ description: 'Masa berlaku access token (detik)' }),
});
const Product = z.object({
  id,
  name: z.string(),
  price: z.int().meta({ description: 'Rupiah' }),
  stock: z.int().min(0),
  revision: z
    .int()
    .min(0)
    .meta({ description: 'Naik setiap perubahan; kirim sebagai expectedRevision' }),
});
const ProductPage = z.object({
  products: z.array(Product),
  total: z.int().optional().meta({ description: 'Tidak ada pada pencarian ?ids=' }),
  offset: z.int().optional(),
  limit: z.int().optional(),
});
const StockSummary = z.object({
  totalProducts: z.int(),
  lowStock: z.int(),
  outOfStock: z.int(),
});
const CartLine = z.object({
  productId: id,
  quantity: z.int().min(1),
  name: z.string(),
  unitPrice: z.int(),
  stock: z.int(),
  available: z.boolean(),
  subtotal: z.int(),
});
// Mutations return the stored snapshot; only GET /cart fetches a product quote.
const CartSnapshot = z.object({
  version: id,
  items: z.array(orderSchemas.itemSchema),
  updatedAt: timestamp,
});
const Cart = z.object({
  version: id.meta({ description: 'Sama dengan ETag; kirim kembali sebagai If-Match' }),
  items: z.array(CartLine),
  total: z.int(),
  quantity: z.int(),
  canCheckout: z.boolean(),
  updatedAt: timestamp,
});
const OrderLine = z.object({
  productId: id,
  name: z.string(),
  unitPrice: z.int(),
  quantity: z.int().min(1),
  subtotal: z.int(),
});
const OrderStatus = orderSchemas.orderStatusSchema;
const Order = z.object({
  id,
  userId: z.string(),
  items: z.array(OrderLine),
  total: z.int(),
  status: OrderStatus,
  fulfillmentStatus: z.enum(['NEW', 'PROCESSING', 'COMPLETED']),
  createdAt: timestamp,
  updatedAt: timestamp,
  shippingAddress: orderSchemas.addressSchema.optional(),
  cartVersion: id.optional(),
  cancelledBy: z.enum(['customer', 'admin']).optional(),
  cancelReason: z.string().optional(),
  cancelledAt: timestamp.optional(),
});
const OrderPage = z.object({
  orders: z.array(Order),
  total: z.int(),
  offset: z.int(),
  limit: z.int(),
  nextCursor: z
    .string()
    .nullable()
    .meta({ description: 'Kirim sebagai ?cursor= untuk halaman berikutnya; null bila habis' }),
});
const OrderSummary = z.object({
  totalOrders: z.int(),
  confirmedOrders: z.int(),
  pendingOrders: z.int(),
  failedOrders: z.int(),
  cancelledOrders: z.int(),
  confirmedValue: z.int(),
  processingOrders: z.int(),
});
const Health = z.object({
  status: z.enum(['ok', 'degraded']),
  gateway: z.string(),
  services: z.record(z.string(), z.enum(['up', 'down'])),
  timestamp,
});
const ServiceHealth = z.object({ status: z.literal('ok'), service: z.string() });
const Jwks = z.object({ keys: z.array(z.looseObject({ kid: z.string(), kty: z.string() })) });

/** Response schemas by component name; E2E validates live responses against these. */
export const responses = {
  Error: ErrorBody,
  User,
  Session,
  Product,
  ProductPage,
  StockSummary,
  Cart,
  CartSnapshot,
  Order,
  OrderPage,
  OrderSummary,
  Health,
  ServiceHealth,
  Jwks,
  UserEnvelope: z.object({ user: User }),
  Outbox: z.object({ messages: z.array(OutboxMessage) }),
  Accepted: z.object({ sent: z.literal(true) }),
  Liveness: z.object({ service: z.string(), status: z.literal('ok') }),
  ProductEnvelope: z.object({ product: Product }),
  CartEnvelope: z.object({ cart: Cart }),
  CartMutationEnvelope: z.object({ cart: CartSnapshot }),
  OrderEnvelope: z.object({ order: Order }),
};
const requests = {
  Credentials: credentialsSchema.meta({
    description:
      'Email di-trim, diubah ke huruf kecil, lalu diperiksa format emailnya. Password minimal ' +
      '8 unit UTF-16 dan maksimal 72 byte UTF-8. Batas byte dan normalisasi tidak terwakili ' +
      'sepenuhnya oleh minLength/format JSON Schema.',
  }),
  VerifyEmailInput: verifyEmailSchema,
  ProductInput: productSchema,
  ProductUpdate: productUpdateSchema.meta({
    description:
      'Minimal satu field name, price, atau stock wajib diisi; expectedRevision saja tidak cukup. ' +
      'Nama di-trim sebelum validasi. expectedRevision opsional untuk kompatibilitas klien lama.',
  }),
  OrderInput: orderSchemas.orderSchema,
  CheckoutInput: orderSchemas.checkoutSchema,
  CartQuantity: orderSchemas.quantitySchema,
  FulfillmentUpdate: orderSchemas.fulfillmentSchema,
  CancelInput: orderSchemas.cancelSchema,
};

function components(schemas, io) {
  const registry = z.registry();
  for (const [name, schema] of Object.entries(schemas)) registry.add(schema, { id: name });
  const { schemas: out } = z.toJSONSchema(registry, {
    io,
    unrepresentable: 'any',
    uri: (name) => `#/components/schemas/${name}`,
  });
  for (const schema of Object.values(out)) {
    delete schema.$schema;
    delete schema.$id; // a fragment-only $id is not valid in JSON Schema 2020-12
    delete schema.id;
  }
  return withoutSafeIntegerBounds(out);
}

/** zod states Number.MAX_SAFE_INTEGER bounds on every integer; they add only noise. */
function withoutSafeIntegerBounds(value) {
  if (Array.isArray(value)) return value.map(withoutSafeIntegerBounds);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'minimum' && inner === Number.MIN_SAFE_INTEGER) continue;
    if (key === 'maximum' && inner === Number.MAX_SAFE_INTEGER) continue;
    copy[key] = withoutSafeIntegerBounds(inner);
  }
  return copy;
}

/** A standalone JSON Schema embedded in OpenAPI does not repeat its dialect. */
function plain(schema) {
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
}

/** Query parameters from a zod object schema (one parameter per property). */
function queryParameters(schema, descriptions = {}) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return Object.entries(json.properties).map(([name, property]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    ...(descriptions[name] ? { description: descriptions[name] } : {}),
    schema: withoutSafeIntegerBounds(property),
  }));
}

// ---------------------------------------------------------------- operations
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (name, { description = 'OK', headers } = {}) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/json': { schema: ref(name) } },
});
const body = (name, required = true) => ({
  required,
  content: { 'application/json': { schema: ref(name) } },
});
const errors = (...codes) =>
  Object.fromEntries(codes.map((code) => [code, { $ref: `#/components/responses/E${code}` }]));
const pathId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const bearer = [{ bearerAuth: [] }];
const cookie = [{ refreshCookie: [] }];
const etag = { ETag: { $ref: '#/components/headers/ETag' } };
const ifMatch = { $ref: '#/components/parameters/IfMatch' };
const idempotencyKey = { $ref: '#/components/parameters/IdempotencyKey' };
const requestedWith = { $ref: '#/components/parameters/XRequestedWith' };

const pagination = queryParameters(orderSchemas.paginationSchema, {
  offset: 'Halaman bernomor; maksimal 10000. Offset selain 0 tidak boleh digabung dengan cursor.',
  cursor: 'Nilai nextCursor dari halaman sebelumnya (keyset, stabil saat data baru masuk).',
  q: 'Cari pada ID order atau nama penerima.',
});

const operations = {
  '/auth/register': {
    post: {
      operationId: 'register',
      tags: ['auth'],
      summary: 'Daftar akun pembeli (role selalu user)',
      requestBody: body('Credentials'),
      responses: {
        201: json('UserEnvelope', {
          description: 'Akun dibuat; tautan verifikasi dikirim ke email (emailVerified: false)',
        }),
        ...errors(400, 409, 429),
      },
    },
  },
  '/auth/verify-email': {
    post: {
      operationId: 'verifyEmail',
      tags: ['auth'],
      summary: 'Tukar token dari email verifikasi (sekali pakai, 24 jam)',
      description:
        'Access token yang sudah terbit tetap berisi email_verified: false sampai sesi di-refresh.',
      requestBody: body('VerifyEmailInput'),
      responses: {
        200: json('UserEnvelope', { description: 'Email terverifikasi' }),
        ...errors(400, 429),
      },
    },
  },
  '/auth/email-verification': {
    post: {
      operationId: 'resendVerification',
      tags: ['auth'],
      summary: 'Kirim ulang email verifikasi untuk pengguna yang login (maks. 1 per menit)',
      security: bearer,
      responses: {
        202: json('Accepted', { description: 'Email dikirim' }),
        ...errors(401, 409, 429),
      },
    },
  },
  '/auth/admin/outbox': {
    get: {
      operationId: 'trainingOutbox',
      tags: ['auth', 'admin'],
      summary: 'Kotak surat pelatihan (admin): email yang "dikirim" sistem',
      description:
        'Hanya ada bila MAIL_TRANSPORT=outbox (pelatihan/lokal). Dengan transport webhook route ini 404.',
      security: bearer,
      parameters: queryParameters(outboxQuerySchema, { to: 'Alamat penerima persis' }),
      responses: { 200: json('Outbox'), ...errors(400, 401, 403, 404) },
    },
  },
  '/auth/login': {
    post: {
      operationId: 'login',
      tags: ['auth'],
      summary: 'Masuk; mengirim access token dan cookie refresh HttpOnly',
      requestBody: body('Credentials'),
      responses: {
        200: json('Session', {
          description: 'Masuk berhasil',
          headers: {
            'Set-Cookie': {
              description: 'refresh_token; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth',
              schema: { type: 'string' },
            },
          },
        }),
        ...errors(400, 401, 429),
      },
    },
  },
  '/auth/refresh': {
    post: {
      operationId: 'refreshSession',
      tags: ['auth'],
      summary: 'Tukar cookie refresh dengan access token baru (rotasi)',
      security: cookie,
      parameters: [requestedWith],
      responses: {
        200: json('Session', { description: 'Sesi diperpanjang; cookie refresh diganti' }),
        ...errors(401, 403, 409, 429),
      },
    },
  },
  '/auth/logout': {
    post: {
      operationId: 'logout',
      tags: ['auth'],
      summary: 'Cabut sesi dari cookie atau bearer dan hapus cookie',
      description:
        'Cookie refresh dan bearer JWT bersifat opsional; setiap sesi valid yang disertakan dicabut. ' +
        'Bearer memungkinkan logout saat cookie telah hilang. Kredensial tidak valid diabaikan ' +
        'agar logout tetap idempotent, dan tanpa kredensial tidak ada sesi server yang dicabut. ' +
        'JWT sesi yang dicabut ditolak langsung oleh auth-service; service lain menyegarkan daftar ' +
        'pencabutan sesuai REVOCATION_MAX_AGE_MS (bawaan 5 detik). Header X-Requested-With tetap wajib.',
      security: [...cookie, ...bearer, {}],
      parameters: [requestedWith],
      responses: { 204: { description: 'Sesi dicabut' }, ...errors(403, 429) },
    },
  },
  '/auth/me': {
    get: {
      operationId: 'currentUser',
      tags: ['auth'],
      summary: 'Profil pemilik access token',
      security: bearer,
      responses: { 200: json('UserEnvelope'), ...errors(401) },
    },
  },
  '/auth/.well-known/jwks.json': {
    get: {
      operationId: 'jwks',
      tags: ['auth'],
      summary: 'Public key untuk memverifikasi access token (RFC 7517)',
      responses: { 200: json('Jwks') },
    },
  },
  '/auth/health': {
    get: {
      operationId: 'authHealth',
      tags: ['operations'],
      summary: 'Health auth-service',
      responses: { 200: json('ServiceHealth') },
    },
  },
  '/products': {
    get: {
      operationId: 'listProducts',
      tags: ['products'],
      summary: 'Katalog: cari, halaman, atau ambil beberapa produk sekaligus',
      parameters: [
        { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 } },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
        },
        {
          name: 'offset',
          in: 'query',
          schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
        },
        {
          name: 'ids',
          in: 'query',
          description: 'Maksimal 50 UUID dipisah koma; produk yang tidak ada dilewati',
          schema: { type: 'string', maxLength: 2000 },
        },
      ],
      responses: { 200: json('ProductPage'), ...errors(400, 429) },
    },
    post: {
      operationId: 'createProduct',
      tags: ['products', 'admin'],
      summary: 'Tambah produk (admin)',
      security: bearer,
      requestBody: body('ProductInput'),
      responses: {
        201: json('ProductEnvelope', { description: 'Produk dibuat' }),
        ...errors(400, 401, 403),
      },
    },
  },
  '/products/admin/summary': {
    get: {
      operationId: 'stockSummary',
      tags: ['products', 'admin'],
      summary: 'Ringkasan stok (admin)',
      security: bearer,
      responses: { 200: json('StockSummary'), ...errors(401, 403) },
    },
  },
  '/products/{id}': {
    parameters: [pathId],
    get: {
      operationId: 'getProduct',
      tags: ['products'],
      summary: 'Detail produk',
      responses: { 200: json('ProductEnvelope'), ...errors(404) },
    },
    put: {
      operationId: 'updateProduct',
      tags: ['products', 'admin'],
      summary: 'Ubah produk (admin); expectedRevision mencegah menimpa perubahan lain',
      security: bearer,
      requestBody: body('ProductUpdate'),
      responses: { 200: json('ProductEnvelope'), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      operationId: 'deleteProduct',
      tags: ['products', 'admin'],
      summary: 'Hapus produk (admin)',
      security: bearer,
      responses: { 204: { description: 'Dihapus' }, ...errors(401, 403, 404) },
    },
  },
  '/cart': {
    get: {
      operationId: 'getCart',
      tags: ['cart'],
      summary: 'Keranjang dengan harga dan stok terkini',
      security: bearer,
      responses: { 200: json('CartEnvelope', { headers: etag }), ...errors(401, 503) },
    },
    delete: {
      operationId: 'clearCart',
      tags: ['cart'],
      summary: 'Kosongkan keranjang',
      security: bearer,
      parameters: [ifMatch],
      responses: {
        204: { description: 'Dikosongkan', headers: etag },
        ...errors(400, 401, 412, 428),
      },
    },
  },
  '/cart/items/{id}': {
    parameters: [pathId],
    put: {
      operationId: 'setCartItem',
      tags: ['cart'],
      summary: 'Atur jumlah satu produk di keranjang',
      security: bearer,
      parameters: [ifMatch],
      requestBody: body('CartQuantity'),
      responses: {
        200: json('CartMutationEnvelope', { headers: etag }),
        ...errors(400, 401, 409, 412, 428),
      },
    },
    delete: {
      operationId: 'removeCartItem',
      tags: ['cart'],
      summary: 'Hapus satu produk dari keranjang',
      security: bearer,
      parameters: [ifMatch],
      responses: {
        200: json('CartMutationEnvelope', { headers: etag }),
        ...errors(400, 401, 409, 412, 428),
      },
    },
  },
  '/cart/checkout': {
    post: {
      operationId: 'checkout',
      tags: ['cart', 'orders'],
      summary: 'Checkout keranjang versi tertentu (idempoten)',
      description:
        'Email harus terverifikasi. Batas per pengguna berlaku di seluruh pesanan aktif, ' +
        'termasuk pembatalan yang stoknya belum berhasil dilepas. Bawaan: 5 pesanan dan ' +
        '10 unit per produk; dapat dikonfigurasi operator.',
      security: bearer,
      parameters: [idempotencyKey],
      requestBody: body('CheckoutInput'),
      responses: {
        201: json('OrderEnvelope', { description: 'Order dibuat atau dikembalikan ulang' }),
        ...errors(400, 401, 403, 409, 503),
      },
    },
  },
  '/orders': {
    get: {
      operationId: 'listMyOrders',
      tags: ['orders'],
      summary: 'Riwayat order milik pemanggil, terbaru dulu',
      security: bearer,
      parameters: pagination,
      responses: { 200: json('OrderPage'), ...errors(400, 401) },
    },
    post: {
      operationId: 'createOrder',
      tags: ['orders'],
      summary: 'Buat order langsung (idempoten, dibatasi per pelanggan)',
      description:
        'Email harus terverifikasi. Batas per pengguna berlaku di seluruh pesanan aktif, ' +
        'termasuk pembatalan yang stoknya belum berhasil dilepas. Bawaan: 5 pesanan dan ' +
        '10 unit per produk; baris produk duplikat dijumlahkan sebelum pemeriksaan.',
      security: bearer,
      parameters: [idempotencyKey],
      requestBody: body('OrderInput'),
      responses: {
        201: json('OrderEnvelope', { description: 'Order dibuat atau dikembalikan ulang' }),
        ...errors(400, 401, 403, 409, 503),
      },
    },
  },
  '/orders/{id}': {
    parameters: [pathId],
    get: {
      operationId: 'getMyOrder',
      tags: ['orders'],
      summary: 'Detail order milik pemanggil (order orang lain: 404)',
      security: bearer,
      responses: { 200: json('OrderEnvelope'), ...errors(400, 401, 404) },
    },
  },
  '/orders/{id}/cancel': {
    parameters: [pathId],
    post: {
      operationId: 'cancelMyOrder',
      tags: ['orders'],
      summary: 'Batalkan order sendiri selama belum diproses',
      security: bearer,
      requestBody: body('CancelInput', false),
      responses: {
        200: json('OrderEnvelope', { description: 'Dibatalkan, stok dikembalikan' }),
        202: json('OrderEnvelope', {
          description: 'Niat batal tersimpan; stok dikembalikan otomatis',
        }),
        ...errors(400, 401, 404, 409),
      },
    },
  },
  '/orders/admin': {
    get: {
      operationId: 'listAllOrders',
      tags: ['orders', 'admin'],
      summary: 'Semua order (admin)',
      security: bearer,
      parameters: pagination,
      responses: { 200: json('OrderPage'), ...errors(400, 401, 403) },
    },
  },
  '/orders/admin/summary': {
    get: {
      operationId: 'orderSummary',
      tags: ['orders', 'admin'],
      summary: 'Ringkasan order (admin)',
      security: bearer,
      responses: { 200: json('OrderSummary'), ...errors(401, 403) },
    },
  },
  '/orders/admin/{id}': {
    parameters: [pathId],
    get: {
      operationId: 'getAnyOrder',
      tags: ['orders', 'admin'],
      summary: 'Detail order mana pun (admin)',
      security: bearer,
      responses: { 200: json('OrderEnvelope'), ...errors(400, 401, 403, 404) },
    },
  },
  '/orders/admin/{id}/fulfillment': {
    parameters: [pathId],
    patch: {
      operationId: 'updateFulfillment',
      tags: ['orders', 'admin'],
      summary: 'Majukan status pemenuhan: NEW → PROCESSING → COMPLETED (admin)',
      security: bearer,
      requestBody: body('FulfillmentUpdate'),
      responses: { 200: json('OrderEnvelope'), ...errors(400, 401, 403, 404, 409) },
    },
  },
  '/orders/admin/{id}/cancel': {
    parameters: [pathId],
    post: {
      operationId: 'cancelAnyOrder',
      tags: ['orders', 'admin'],
      summary: 'Batalkan order yang belum selesai (admin)',
      security: bearer,
      requestBody: body('CancelInput', false),
      responses: {
        200: json('OrderEnvelope', { description: 'Dibatalkan, stok dikembalikan' }),
        202: json('OrderEnvelope', {
          description: 'Niat batal tersimpan; stok dikembalikan otomatis',
        }),
        ...errors(400, 401, 403, 404, 409),
      },
    },
  },
  '/openapi.json': {
    get: {
      operationId: 'openapi',
      tags: ['operations'],
      summary: 'Dokumen ini',
      responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': {} } } },
    },
  },
  '/': {
    servers: [{ url: '/api', description: 'Tidak berversi' }],
    get: {
      operationId: 'gatewayLiveness',
      tags: ['operations'],
      summary: 'Liveness gateway (dipakai healthcheck container)',
      responses: { 200: json('Liveness') },
    },
  },
  '/health': {
    get: {
      operationId: 'gatewayHealth',
      tags: ['operations'],
      summary: 'Status gateway dan service di belakangnya',
      description: 'Juga tersedia tanpa versi di /api/health untuk healthcheck container.',
      responses: {
        200: json('Health'),
        503: json('Health', { description: 'Ada service yang tidak terjangkau' }),
      },
    },
  },
};

const errorDescriptions = {
  400: 'Request tidak valid (VALIDATION_ERROR, INVALID_CURSOR, INVALID_PRECONDITION, ...)',
  401: 'Token tidak ada, kedaluwarsa, atau sesinya sudah dicabut (SESSION_REVOKED)',
  403: 'Role tidak cukup, email belum diverifikasi (EMAIL_NOT_VERIFIED), atau CSRF_REJECTED',
  404: 'Tidak ditemukan atau bukan milik pemanggil',
  409: 'Konflik bisnis: stok, idempotensi, status, HOLD_LIMIT_EXCEEDED, REFRESH_RACE, EMAIL_ALREADY_VERIFIED',
  412: 'If-Match tidak cocok dengan versi keranjang (CART_CHANGED)',
  413: 'Body request melebihi batas ukuran',
  428: 'If-Match wajib dikirim (PRECONDITION_REQUIRED)',
  429: 'Terlalu banyak request; lihat Retry-After',
  502: 'Respons upstream tidak memenuhi kontrak atau operasi upstream ditolak',
  503: 'Service di belakang tidak terjangkau; aman dicoba ulang dengan key yang sama',
  504: 'Waktu tunggu upstream habis',
};

// Errors from middleware/proxies also belong to the public contract. Public
// operations explicitly declare security: [] so scanners need not guess.
const methodNames = ['get', 'post', 'put', 'patch', 'delete'];
const documentedOperations = Object.fromEntries(
  Object.entries(operations).map(([path, item]) => [
    path,
    Object.fromEntries(
      Object.entries(item).map(([method, operation]) => {
        if (!methodNames.includes(method)) return [method, operation];
        const proxied = /^\/(auth|products|orders|cart)(\/|$)/.test(path);
        const middlewareErrors =
          path === '/' || path === '/health'
            ? {}
            : errors(...(proxied ? [413, 429, 502, 503, 504] : [429]));
        return [
          method,
          {
            security: [],
            ...operation,
            responses: { ...middlewareErrors, ...operation.responses },
          },
        ];
      }),
    ),
  ]),
);

export function buildSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'E-Commerce Microservices API',
      version: API_VERSION,
      description: [
        'API publik di balik gateway. Base URL `/api/v1`.',
        '',
        `Jalur tanpa versi (\`/api/...\`) masih dilayani sebagai alias usang dengan header ` +
          `\`Deprecation\`, \`Sunset\` (${LEGACY_SUNSET}) dan \`Link: rel="successor-version"\`.`,
        '',
        'Dokumen ini dibangkitkan oleh `node scripts/openapi.mjs` dari skema zod tiap service; ' +
          'jangan diedit manual.',
        'Validasi byte UTF-8, normalisasi, aturan antar-field, dan aturan bisnis tetap ' +
          'dijalankan oleh service; constraint tersebut dijelaskan pada operasi/skema terkait.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1', description: 'Gateway melalui frontend (nginx)' }],
    tags: [
      { name: 'auth', description: 'Akun, sesi, dan kunci verifikasi token' },
      { name: 'products', description: 'Katalog dan stok' },
      { name: 'cart', description: 'Keranjang dengan konkurensi If-Match/ETag' },
      { name: 'orders', description: 'Order, checkout, pembatalan' },
      { name: 'admin', description: 'Hanya role admin' },
      { name: 'operations', description: 'Health dan metadata' },
    ],
    paths: documentedOperations,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
      },
      parameters: {
        IfMatch: {
          name: 'If-Match',
          in: 'header',
          required: true,
          description: 'ETag keranjang terakhir, mis. "3f1c…" (dengan tanda kutip)',
          schema: { type: 'string', maxLength: 100 },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Kunci unik per percobaan; dipakai ulang saat retry. Diingat 24 jam setelah order selesai.',
          schema: plain(z.toJSONSchema(orderSchemas.keySchema, { io: 'input' })),
        },
        XRequestedWith: {
          name: 'X-Requested-With',
          in: 'header',
          required: true,
          description: 'Header kustom wajib (pertahanan CSRF untuk endpoint berbasis cookie)',
          schema: { type: 'string', maxLength: 100 },
        },
      },
      headers: {
        ETag: { description: 'Versi keranjang dalam tanda kutip', schema: { type: 'string' } },
      },
      responses: Object.fromEntries(
        Object.entries(errorDescriptions).map(([code, description]) => [
          `E${code}`,
          { description, content: { 'application/json': { schema: ref('Error') } } },
        ]),
      ),
      schemas: { ...components(requests, 'input'), ...components(responses, 'output') },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = `${JSON.stringify(buildSpec(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      /* missing file is out of date */
    }
    if (current !== text) {
      console.error('openapi.json is out of date. Run: node scripts/openapi.mjs');
      process.exit(1);
    }
    console.log('openapi.json is up to date');
  } else {
    writeFileSync(OUTPUT, text);
    console.log(`wrote ${OUTPUT}`);
  }
}
