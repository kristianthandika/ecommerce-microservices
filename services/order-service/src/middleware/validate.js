/**
 * Middleware validasi berbasis zod (reusable). Pakai:
 *   router.post('/register', validate(registerSchema), handler)
 *
 * Kalau body tidak valid, `schema.parse` melempar ZodError yang — berkat
 * penanganan error async bawaan Express 5 — otomatis sampai ke error handler
 * terpusat dan dipetakan jadi response 400 (BUKAN 500). Data yang sudah
 * ter-parse & ter-sanitasi ditaruh di `req.validated`.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} source
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    req.validated = schema.parse(req[source]);
    next();
  };
}
