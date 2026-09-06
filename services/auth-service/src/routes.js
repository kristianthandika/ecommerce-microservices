import { Router } from 'express';
import { z } from 'zod';
import { validate } from './middleware/validate.js';
import { requireAuth } from './middleware/require-auth.js';
import { getKeyMaterial } from './keys.js';
import { register, login, getUserById } from './users.js';

const credentialsSchema = z.object({
  email: z.string().email('Email tidak valid'),
  password: z.string().min(8, 'Password minimal 8 karakter'),
});

export function buildRouter() {
  const router = Router();

  // Health check — dipakai gateway (m3.3) & Docker healthcheck (m4.4).
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'auth-service' });
  });

  // Endpoint JWKS standar — service lain mem-fetch public key dari sini.
  router.get('/.well-known/jwks.json', (_req, res) => {
    const { jwk } = getKeyMaterial();
    res.json({ keys: [jwk] });
  });

  // Perhatikan: TIDAK ada try/catch — handler async yang throw/reject otomatis
  // diteruskan ke error handler oleh Express 5.
  router.post('/register', validate(credentialsSchema), async (req, res) => {
    const user = await register(req.validated);
    res.status(201).json({ user });
  });

  router.post('/login', validate(credentialsSchema), async (req, res) => {
    const result = await login(req.validated);
    res.json(result);
  });

  // Route terproteksi contoh — butuh token valid.
  router.get('/me', requireAuth, (req, res) => {
    const user = getUserById(req.user.sub);
    res.json({ user });
  });

  return router;
}
