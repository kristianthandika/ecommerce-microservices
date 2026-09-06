import { Router } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.js';
import { requireAuth } from './middleware/require-auth.js';
import { createOrder, listOrdersForUser, getOrder } from './orders.js';

const orderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1, 'productId wajib'),
        quantity: z.number().int().positive('quantity harus > 0'),
      }),
    )
    .min(1, 'Order harus punya minimal 1 item'),
});

export function buildRouter() {
  const router = Router();

  router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'order-service' }));

  router.post('/orders', requireAuth, validate(orderSchema), async (req, res) => {
    const order = await createOrder(
      { userId: req.user.sub, items: req.validated.items },
      { correlationId: req.id }, // teruskan correlation ID ke product-service
    );
    res.status(201).json({ order });
  });

  router.get('/orders', requireAuth, (req, res) => {
    res.json({ orders: listOrdersForUser(req.user.sub) });
  });

  router.get('/orders/:id', requireAuth, (req, res) => {
    res.json({ order: getOrder(req.params.id, req.user.sub) });
  });

  return router;
}
