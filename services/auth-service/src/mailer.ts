import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { database } from './database.ts';

/**
 * Outgoing mail behind one function, so the rest of the service never knows how
 * mail leaves the building.
 *
 * - `outbox` keeps messages in this service's database for 24 hours, readable by
 *   administrators through GET /admin/outbox. For training and local development
 *   only: whoever can read the outbox can use the password-reset links in it, and
 *   so take over any account.
 * - `webhook` POSTs `{ to, subject, text }` as JSON to MAIL_WEBHOOK_URL (a mail API
 *   or relay run by the operator). Nothing is stored here.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The action link inside `text`, kept separately so tools need not parse prose. */
  link?: string;
}
export interface OutboxMessage extends Mail {
  id: string;
  createdAt: string;
}

const OUTBOX_RETENTION_MS = 24 * 3_600_000;
const outbox = database.store<OutboxMessage>('outbox');

export type MailKind = 'verification' | 'account-exists' | 'password-reset';
interface MailQuota {
  sentAt: number; // last mail that was really sent
  askedAt: number;
  windowStart?: number; // start of the 24-hour window `sent` counts in
  sent?: number;
}
const sends = database.store<MailQuota>('mail_sends');
const DAY_MS = 24 * 3_600_000;

/**
 * Claims a mail of `kind` to `to`: at most one per cooldown and `dailyLimit` per 24
 * hours. False otherwise; the caller then sends nothing and tells nobody.
 *
 * Public endpoints (register, password reset) answer every request the same way, so
 * this is what keeps them from flooding a mailbox. The record is written on every
 * call, also for addresses without an account: a request that leads to a mail and
 * one that does not cost the same.
 */
export function reserveMail(kind: MailKind, to: string, now = Date.now()): boolean {
  const key = `${kind}:${to}`;
  return database.transaction(() => {
    const last = sends.get(key);
    const { cooldownMs, dailyLimit } = config.mail;
    const previousStart = last ? (last.windowStart ?? last.sentAt) : undefined;
    const sameWindow = previousStart !== undefined && now - previousStart < DAY_MS;
    const windowStart = sameWindow ? previousStart : now;
    const sentInWindow = sameWindow ? (last?.sent ?? 1) : 0;
    const allowed = (!last || now - last.sentAt >= cooldownMs) && sentInWindow < dailyLimit;
    sends.set(
      key,
      {
        sentAt: allowed || !last ? now : last.sentAt,
        askedAt: now,
        windowStart,
        sent: sentInWindow + (allowed ? 1 : 0),
      },
      windowStart + DAY_MS,
    );
    return allowed;
  });
}

export async function deliver(mail: Mail, now = Date.now()): Promise<void> {
  if (config.mail.transport === 'webhook') {
    const response = await fetch(config.mail.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.mail.webhookToken
          ? { authorization: `Bearer ${config.mail.webhookToken}` }
          : {}),
      },
      body: JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(5000),
      // The address comes from operator configuration; never follow it elsewhere.
      redirect: 'error',
    });
    // The relay acknowledgement has no useful body; release even an endless stream.
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Mail webhook answered ${response.status}`);
    return;
  }
  const id = randomUUID();
  outbox.insert(
    id,
    { id, ...mail, createdAt: new Date(now).toISOString() },
    now + OUTBOX_RETENTION_MS,
  );
}

/** Newest first. `to` filters on the exact (normalized) recipient address. */
export function listOutbox(
  { to, limit = 20 }: { to?: string; limit?: number } = {},
  now = Date.now(),
): OutboxMessage[] {
  // Limit in SQL, and enforce expiry even between retention sweeps.
  const rows = database
    .statement(
      `SELECT value FROM records WHERE namespace='outbox' AND expires_at>?
     ${to ? "AND json_extract(value, '$.to')=?" : ''}
     ORDER BY json_extract(value, '$.createdAt') DESC, key DESC LIMIT ?`,
    )
    .all(...(to ? [now, to, limit] : [now, limit]));
  return rows.map((row) => JSON.parse(String(row.value)) as OutboxMessage);
}

export function purgeExpiredMail(now = Date.now(), batch = 500) {
  return database.transaction(() => ({
    outbox: outbox.sweep(now, batch, () => 'delete'),
    sends: sends.sweep(now, batch, () => 'delete'),
  }));
}

/** Test helper. */
export function _resetOutbox(): void {
  outbox.clear();
  sends.clear();
}
