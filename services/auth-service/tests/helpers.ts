import request from 'supertest';
import type { Express } from 'express';

type LinkKind = 'verify-email' | 'reset-password';

/** Mail in the training outbox for `address`, newest first. */
export async function mailsFor(address: string) {
  const { listOutbox } = await import('../src/mailer.ts');
  return listOutbox({ to: address.trim().toLowerCase(), limit: 100 });
}

/**
 * Token from the newest mailed link of `kind`. Mail leaves after the HTTP response,
 * so this waits briefly for it instead of assuming it is already there.
 */
export async function mailedToken(
  address: string,
  kind: LinkKind = 'verify-email',
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const mail = (await mailsFor(address)).find((item) => item.link?.includes(`/${kind}#token=`));
    if (mail?.link) return mail.link.split('#token=')[1];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No ${kind} mail for ${address}`);
}

/** Lets work scheduled "after the response" (mail) run before the test looks for it. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let sequence = 0;
/** A client address of its own, so the per-IP limiters never decide a test. */
export const nextIp = () => `203.0.113.${(++sequence % 250) + 1}`;

/** Registers and verifies an account, like a user who followed the mailed link. */
export async function signUp(app: Express, email: string, password: string, ip = nextIp()) {
  const registered = await request(app)
    .post('/register')
    .set('x-forwarded-for', ip)
    .send({ email, password });
  if (registered.status !== 202) throw new Error(`register answered ${registered.status}`);
  const verified = await request(app)
    .post('/verify-email')
    .set('x-forwarded-for', ip)
    .send({ token: await mailedToken(email), password });
  if (verified.status !== 200) throw new Error(`verify-email answered ${verified.status}`);
  return verified.body.user as { id: string; email: string; role: string; emailVerified: boolean };
}

/** One named cookie from a response: its value and the full Set-Cookie line. */
export function cookieOf(res: request.Response, name: string) {
  const header = ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((cookie) => cookie.startsWith(`${name}=`));
  return header ? { value: header.split(';')[0].slice(name.length + 1), header } : undefined;
}
