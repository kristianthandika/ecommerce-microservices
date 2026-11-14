import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.ts';
import { requireAuth } from './middleware/require-auth.ts';
import { requireRole } from './middleware/require-role.ts';
import { requireServiceToken } from './middleware/service-token.ts';
import { productSchema, productUpdateSchema, reservationSchema } from './schemas.ts';
import {
  getProduct,
  getProducts,
  searchProducts,
  stockSummary,
  createProduct,
  updateProduct,
  deleteProduct,
  type ProductInput,
  reserveStock,
  releaseReservation,
} from './products.ts';

export function buildRouter(): Router {
  const router = Router();
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
    res.json(stockSummary());
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
      res.json({ products: getProducts(ids) });
      return;
    }
    const q = z.string().trim().max(100).default('').parse(req.query.q).toLowerCase();
    const limit = z.coerce.number().int().min(1).max(100).default(100).parse(req.query.limit);
    const offset = z.coerce.number().int().min(0).max(10_000).default(0).parse(req.query.offset);
    res.json({ ...searchProducts({ q, offset, limit }), offset, limit });
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
