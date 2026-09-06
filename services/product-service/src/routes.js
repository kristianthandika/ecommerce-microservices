import { Router } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.js';
import { requireAuth } from './middleware/require-auth.js';
import { requireRole } from './middleware/require-role.js';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from './products.js';

const productSchema = z.object({
  name: z.string().min(1, 'Nama produk wajib diisi'),
  price: z.number().positive('Harga harus lebih dari 0'),
  stock: z.number().int().nonnegative('Stok tidak boleh negatif').default(0),
});

const productUpdateSchema = productSchema.partial();

export function buildRouter() {
  const router = Router();

  router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'product-service' }));

  // Publik: baca katalog.
  router.get('/products', (_req, res) => res.json({ products: listProducts() }));
  router.get('/products/:id', (req, res) => res.json({ product: getProduct(req.params.id) }));

  // Admin-only: kelola katalog (RBAC + validasi).
  router.post(
    '/products',
    requireAuth,
    requireRole('admin'),
    validate(productSchema),
    (req, res) => {
      res.status(201).json({ product: createProduct(req.validated) });
    },
  );

  router.put(
    '/products/:id',
    requireAuth,
    requireRole('admin'),
    validate(productUpdateSchema),
    (req, res) => {
      res.json({ product: updateProduct(req.params.id, req.validated) });
    },
  );

  router.delete('/products/:id', requireAuth, requireRole('admin'), (req, res) => {
    deleteProduct(req.params.id);
    res.status(204).end();
  });

  return router;
}
