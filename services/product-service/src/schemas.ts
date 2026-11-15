import { z } from 'zod';

/** Request schemas. Kept free of side effects so the OpenAPI generator can import them. */
export const productSchema = z.object({
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
export const productUpdateSchema = productSchema
  .partial()
  .extend({
    stock: productSchema.shape.stock.unwrap().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
    'Minimal satu field wajib diisi',
  );

// Internal (service-to-service) only; not part of the public API.
export const reservationSchema = z.object({
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
