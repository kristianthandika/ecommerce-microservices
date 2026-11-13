import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.ts';
import { requireAuth } from './middleware/require-auth.ts';
import { requireRole } from './middleware/require-role.ts';
import { requireServiceToken } from './middleware/service-token.ts';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  type ProductInput,
  reserveStock,
  releaseReservation,
} from './products.ts';

const productSchema = z.object({
  // trim() dulu: nama berisi spasi saja bukan nama yang valid.
  name: z.string().trim().min(1, 'Nama produk wajib diisi').max(200, 'Nama terlalu panjang'),
  price: z
    .number()
    .int('Harga harus berupa integer rupiah')
    .positive('Harga harus lebih dari 0')
    .max(1_000_000_000, 'Harga tidak wajar'),
  stock: z
    .number()
    .int()
    .nonnegative('Stok tidak boleh negatif')
    .max(1_000_000, 'Stok tidak wajar')
    .default(0),
});
const productUpdateSchema = productSchema
  .partial()
  .extend({
    stock: productSchema.shape.stock.unwrap().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
    'Minimal satu field wajib diisi',
  );

export function buildRouter(): Router {
  const router = Router();
  const reservationSchema = z.object({
    items: z
      .array(
        z.object({
          productId: z.uuid(),
          quantity: z.number().int().positive().max(50_000),
        }),
      )
      .min(1)
      .max(50),
  });
  // Internal (service-ke-service): TIDAK dirutekan gateway, wajib service token.
  router.post(
    '/internal/reservations/:id',
    requireServiceToken,
    validate(reservationSchema),
    (req, res) => {
      const id = z.uuid().parse(req.params.id);
      const input = req.validated as z.infer<typeof reservationSchema>;
      res.json({ reservation: reserveStock(id, input.items) });
    },
  );
  // Kompensasi saga: kembalikan stok sebuah reservasi (idempotent).
  router.post('/internal/reservations/:id/release', requireServiceToken, (req, res) => {
    res.json({ reservation: releaseReservation(z.uuid().parse(req.params.id)) });
  });

  router.get('/health', (_req: Request, res: Response) =>
    res.json({ status: 'ok', service: 'product-service' }),
  );

  // Admin-only: ringkasan stok. Didaftarkan SEBELUM '/products/:id' supaya
  // 'admin' tidak tertangkap sebagai :id.
  router.get('/products/admin/summary', requireAuth, requireRole('admin'), (_req, res) => {
    const products = listProducts();
    res.json({
      totalProducts: products.length,
      lowStock: products.filter((product) => product.stock > 0 && product.stock <= 5).length,
      outOfStock: products.filter((product) => product.stock === 0).length,
    });
  });

  // Publik: baca katalog.
  router.get('/products', (req: Request, res: Response) => {
    if (req.query.ids !== undefined) {
      const ids = z
        .string()
        .max(2000)
        .transform((value) => value.split(','))
        .pipe(z.array(z.uuid()).min(1).max(50))
        .parse(req.query.ids);
      res.json({
        products: ids.flatMap((id) => {
          try {
            return [getProduct(id)];
          } catch {
            return [];
          }
        }),
      });
      return;
    }
    const q = z.string().trim().max(100).default('').parse(req.query.q).toLowerCase();
    const limit = z.coerce.number().int().min(1).max(100).default(100).parse(req.query.limit);
    const offset = z.coerce.number().int().min(0).default(0).parse(req.query.offset);
    const products = listProducts().filter((product) => product.name.toLowerCase().includes(q));
    res.json({
      products: products.slice(offset, offset + limit),
      total: products.length,
      offset,
      limit,
    });
  });
  router.get('/products/:id', (req: Request, res: Response) =>
    res.json({ product: getProduct(String(req.params.id)) }),
  );

  // Admin-only: kelola katalog (RBAC + validasi).
  router.post(
    '/products',
    requireAuth,
    requireRole('admin'),
    validate(productSchema),
    (req: Request, res: Response) => {
      res.status(201).json({ product: createProduct(req.validated as ProductInput) });
    },
  );

  router.put(
    '/products/:id',
    requireAuth,
    requireRole('admin'),
    validate(productUpdateSchema),
    (req: Request, res: Response) => {
      const { expectedRevision, ...data } = req.validated as Partial<ProductInput> & {
        expectedRevision?: number;
      };
      res.json({ product: updateProduct(String(req.params.id), data, expectedRevision) });
    },
  );

  router.delete(
    '/products/:id',
    requireAuth,
    requireRole('admin'),
    (req: Request, res: Response) => {
      deleteProduct(String(req.params.id));
      res.status(204).end();
    },
  );

  return router;
}
