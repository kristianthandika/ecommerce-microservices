import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.ts';
import { requireAuth } from './middleware/require-auth.ts';
import { requireAdmin } from './middleware/require-role.ts';
import { AppError } from './middleware/errors.ts';
import { database } from './database.ts';
import {
  createOrder,
  getOrder,
  queryOrders,
  adminSummary,
  adminGetOrder,
  updateFulfillment,
  cancelOrder,
} from './orders.ts';
import { getCart, changeItem, clearCart, describeCart } from './cart.ts';
import { checkoutCart } from './checkout.ts';
import {
  orderSchema,
  checkoutSchema,
  quantitySchema,
  fulfillmentSchema,
  keySchema,
  paginationSchema,
  cancelSchema,
} from './schemas.ts';
import { cartPrecondition, sendCartVersion } from './middleware/precondition.ts';

async function respondOrder(
  req: Request,
  res: Response,
  work: (ctx: {
    idempotencyKey: string;
    signal: AbortSignal;
    correlationId?: string;
  }) => Promise<unknown>,
) {
  const idempotencyKey = keySchema.parse(req.get('idempotency-key'));
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abort);
  try {
    res.status(201).json({
      order: await work({
        idempotencyKey,
        signal: controller.signal,
        correlationId: req.id ? String(req.id) : undefined,
      }),
    });
  } finally {
    res.off('close', abort);
  }
}
export function buildRouter(): Router {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'order-service' }));
  router.get('/cart', requireAuth, async (req, res) => {
    // Teruskan correlation ID supaya hop ke product-service tetap tertelusuri.
    const cart = await describeCart(String(req.user?.sub), {
      correlationId: req.id ? String(req.id) : undefined,
    });
    sendCartVersion(res, cart.version);
    res.json({ cart });
  });
  router.put('/cart/items/:id', requireAuth, validate(quantitySchema), (req, res) => {
    const { version, conflictStatus } = cartPrecondition(req, res);
    const productId = z.uuid().parse(req.params.id);
    const { quantity } = req.validated as z.infer<typeof quantitySchema>;
    const cart = changeItem(
      String(req.user?.sub),
      productId,
      quantity,
      'set',
      version,
      conflictStatus,
    );
    sendCartVersion(res, cart.version);
    res.json({ cart });
  });
  router.delete('/cart/items/:id', requireAuth, (req, res) => {
    const { version, conflictStatus } = cartPrecondition(req, res);
    const productId = z.uuid().parse(req.params.id);
    const cart = changeItem(String(req.user?.sub), productId, 0, 'remove', version, conflictStatus);
    sendCartVersion(res, cart.version);
    res.json({ cart });
  });
  router.delete('/cart', requireAuth, (req, res) => {
    const { version, conflictStatus } = cartPrecondition(req, res);
    const userId = String(req.user?.sub);
    database.transaction(() => {
      if (getCart(userId).version !== version)
        throw new AppError(conflictStatus, 'Keranjang berubah', undefined, 'CART_CHANGED');
      clearCart(userId, version);
    });
    sendCartVersion(res, getCart(userId).version);
    res.status(204).end();
  });
  router.post('/cart/checkout', requireAuth, validate(checkoutSchema), async (req, res) => {
    const input = req.validated as z.infer<typeof checkoutSchema>;
    await respondOrder(req, res, (ctx) =>
      checkoutCart(String(req.user?.sub), input.version, input.shippingAddress, ctx),
    );
  });
  router.post('/orders', requireAuth, validate(orderSchema), async (req, res) => {
    await respondOrder(req, res, (ctx) =>
      createOrder(
        {
          userId: String(req.user?.sub),
          items: (req.validated as z.infer<typeof orderSchema>).items,
        },
        ctx,
      ),
    );
  });
  router.get('/orders/admin/summary', requireAuth, requireAdmin, (_req, res) =>
    res.json(adminSummary()),
  );
  router.get('/orders/admin', requireAuth, requireAdmin, (req, res) =>
    res.json(queryOrders(paginationSchema.parse(req.query))),
  );
  router.get('/orders/admin/:id', requireAuth, requireAdmin, (req, res) =>
    res.json({ order: adminGetOrder(z.uuid().parse(req.params.id)) }),
  );
  router.patch('/orders/admin/:id/fulfillment', requireAuth, requireAdmin, (req, res) => {
    const { status } = fulfillmentSchema.parse(req.body);
    res.json({ order: updateFulfillment(z.uuid().parse(req.params.id), status) });
  });
  router.post('/orders/admin/:id/cancel', requireAuth, requireAdmin, async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { reason } = cancelSchema.parse(req.body);
    const result = await cancelOrder(id, { role: 'admin' }, reason, {
      correlationId: req.id ? String(req.id) : undefined,
    });
    // 202: niat batal tersimpan, pelepasan stok diselesaikan proses recovery.
    res.status(result.completed ? 200 : 202).json({ order: result.order });
  });
  router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { reason } = cancelSchema.parse(req.body);
    const result = await cancelOrder(
      id,
      { role: 'customer', userId: String(req.user?.sub) },
      reason,
      { correlationId: req.id ? String(req.id) : undefined },
    );
    res.status(result.completed ? 200 : 202).json({ order: result.order });
  });
  router.get('/orders', requireAuth, (req, res) =>
    res.json(queryOrders({ ...paginationSchema.parse(req.query), userId: String(req.user?.sub) })),
  );
  router.get('/orders/:id', requireAuth, (req, res) =>
    res.json({ order: getOrder(z.uuid().parse(req.params.id), String(req.user?.sub)) }),
  );
  return router;
}
