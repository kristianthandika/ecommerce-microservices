import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATA_DIR', '/unused-in-config-test');
  vi.stubEnv('INTERNAL_SERVICE_TOKEN', 'test-service-token-at-least-32-characters');
  vi.stubEnv('INTERNAL_SERVICE_TOKEN_FILE', '');
  vi.stubEnv('MAIL_TRANSPORT', 'webhook');
  vi.stubEnv('MAIL_ALLOW_INSECURE_OUTBOX', 'false');
  vi.stubEnv('MAIL_WEBHOOK_URL', 'https://relay.example/send');
  vi.stubEnv('MAIL_WEBHOOK_TOKEN', 'test-webhook-token-at-least-32-characters');
  vi.stubEnv('MAIL_WEBHOOK_TOKEN_FILE', '');
  vi.stubEnv('PUBLIC_APP_URL', 'https://shop.example');
});
afterEach(() => vi.unstubAllEnvs());

describe('production mail configuration', () => {
  it('accepts authenticated HTTPS relay and refuses implicit training outbox', async () => {
    expect((await import('../src/config.ts')).config.mail.transport).toBe('webhook');
    vi.resetModules();
    vi.stubEnv('MAIL_TRANSPORT', 'outbox');
    await expect(import('../src/config.ts')).rejects.toThrow('Outbox is training-only');
    vi.resetModules();
    vi.stubEnv('MAIL_ALLOW_INSECURE_OUTBOX', 'true');
    vi.stubEnv('PUBLIC_APP_URL', 'http://localhost:3000');
    expect((await import('../src/config.ts')).config.mail.transport).toBe('outbox');
  });

  it.each([
    ['MAIL_WEBHOOK_URL', 'http://relay.example/send'],
    ['MAIL_WEBHOOK_URL', 'https://user:secret@relay.example/send'],
    ['MAIL_WEBHOOK_URL', 'https://relay.example/send?secret=value'],
    ['PUBLIC_APP_URL', 'http://shop.example'],
    ['PUBLIC_APP_URL', 'https://shop.example#fragment'],
    ['MAIL_WEBHOOK_TOKEN', 'short'],
  ])('rejects unsafe %s configuration', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(import('../src/config.ts')).rejects.toThrow(name);
  });
});
