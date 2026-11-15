import { z } from 'zod';

export const itemSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(1000),
});
export const itemsSchema = z.array(itemSchema).min(1).max(50);
export const addressSchema = z.object({
  recipient: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9() -]{8,24}$/, 'Nomor telepon tidak valid'),
  street: z.string().trim().min(5).max(300),
  city: z.string().trim().min(2).max(100),
  province: z.string().trim().min(2).max(100),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'Kode pos harus 5 digit'),
  notes: z.string().trim().max(500).default(''),
});
export type ShippingAddress = z.infer<typeof addressSchema>;
export const keySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const orderStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'CANCELLATION_REQUESTED',
  'CANCELLED',
]);
/**
 * Numbered pages (`offset`) are capped: deep offsets make the database walk and
 * discard rows. Beyond that, or for feeds, use the opaque `cursor` from `nextCursor`.
 */
export const MAX_OFFSET = 10_000;
export const paginationSchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    status: orderStatusSchema.optional(),
    q: z.string().trim().max(100).default(''),
  })
  .refine((query) => !(query.cursor && query.offset), {
    message: 'Gunakan cursor atau offset, tidak keduanya',
    path: ['cursor'],
  });
export const orderSchema = z.object({ items: itemsSchema });
export const checkoutSchema = z.object({ version: z.uuid(), shippingAddress: addressSchema });
// `version` di body tetap diterima selama masa transisi; If-Match yang diutamakan.
export const quantitySchema = z.object({ quantity: z.number().int().min(1).max(1000) });
export const fulfillmentSchema = z.object({ status: z.enum(['PROCESSING', 'COMPLETED']) });
export const cancelSchema = z
  .object({ reason: z.string().trim().max(200).optional() })
  .optional()
  .transform((value) => value ?? {});
