import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.ts';
import { requireAuth } from './middleware/require-auth.ts';
import { createOrder, listOrdersForUser, getOrder } from './orders.ts';

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
type OrderInput = z.infer<typeof orderSchema>;

export function buildRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) =>
    res.json({ status: 'ok', service: 'order-service' }),
  );

  router.post('/orders', requireAuth, validate(orderSchema), async (req: Request, res: Response) => {
    const order = await createOrder(
      { userId: String(req.user?.sub), items: (req.validated as OrderInput).items },
      { correlationId: req.id ? String(req.id) : undefined }, // teruskan correlation ID
    );
    res.status(201).json({ order });
  });

  router.get('/orders', requireAuth, (req: Request, res: Response) => {
    res.json({ orders: listOrdersForUser(String(req.user?.sub)) });
  });

  router.get('/orders/:id', requireAuth, (req: Request, res: Response) => {
    res.json({ order: getOrder(String(req.params.id), String(req.user?.sub)) });
  });

  return router;
}
