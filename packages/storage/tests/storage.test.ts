import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceDatabase } from '../src/index.ts';

describe('durable service storage', () => {
  it('persists committed records, enforces uniqueness and rolls back failed transactions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'service-db-'));
    let db = new ServiceDatabase('test', directory);
    try {
      const store = db.store<{ stock: number }>('products');
      expect(store.insert('one', { stock: 5 })).toBe(true);
      expect(store.insert('one', { stock: 999 })).toBe(false);
      expect(() =>
        db.transaction(() => {
          store.set('one', { stock: 0 });
          throw new Error('interrupted');
        }),
      ).toThrow('interrupted');
      expect(store.get('one')?.stock).toBe(5);
      await db.backup(join(directory, 'restored.sqlite'));
      const restored = new ServiceDatabase('restored', directory);
      try {
        expect(restored.store<{ stock: number }>('products').get('one')?.stock).toBe(5);
      } finally {
        restored.close();
      }
      db.close();
      db = new ServiceDatabase('test', directory);
      expect(db.store<{ stock: number }>('products').get('one')?.stock).toBe(5);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('joins an open transaction and rolls the whole unit back together', () => {
    const db = new ServiceDatabase('nested', undefined);
    try {
      const store = db.store<number>('counters');
      expect(() =>
        db.transaction(() => {
          store.set('outer', 1);
          db.transaction(() => store.set('inner', 2));
          throw new Error('outer failed');
        }),
      ).toThrow('outer failed');
      expect(store.has('outer')).toBe(false);
      expect(store.has('inner')).toBe(false);
      db.transaction(() => db.transaction(() => store.set('inner', 2)));
      expect(store.get('inner')).toBe(2);
    } finally {
      db.close();
    }
  });

  it('rejects asynchronous callbacks instead of committing before they finish', () => {
    const db = new ServiceDatabase('async', undefined);
    try {
      const store = db.store<number>('counters');
      expect(() =>
        db.transaction(async () => {
          store.set('early', 1);
        }),
      ).toThrow('synchronous');
      expect(store.has('early')).toBe(false);
      // The database stays usable after the rejected callback.
      db.transaction(() => store.set('later', 2));
      expect(store.size).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('schema migrations and retention', () => {
  it('upgrades a v1 database in place, keeps its data and leaves a pre-migration backup', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { readdirSync } = await import('node:fs');
    const { SCHEMA_VERSION } = await import('../src/index.ts');
    const directory = mkdtempSync(join(tmpdir(), 'service-db-migrate-'));
    try {
      // Exactly what the previous release wrote to disk.
      const legacy = new DatabaseSync(join(directory, 'legacy.sqlite'));
      legacy.exec(
        'CREATE TABLE records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key)); PRAGMA user_version=1;',
      );
      legacy.prepare('INSERT INTO records VALUES (?,?,?)').run('orders', 'a', '{"total":5}');
      legacy.close();

      const db = new ServiceDatabase('legacy', directory);
      try {
        expect(db.schemaVersion).toBe(SCHEMA_VERSION);
        expect(db.store<{ total: number }>('orders').get('a')?.total).toBe(5);
        db.store<number>('keys').insert('k', 1, Date.now() + 1000);
      } finally {
        db.close();
      }
      expect(
        readdirSync(directory).some((name) => /legacy\.sqlite\.pre-v2-\d+\.bak$/.test(name)),
      ).toBe(true);
      // Re-opening an up-to-date database is a no-op.
      new ServiceDatabase('legacy', directory).close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a database written by a newer release', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const directory = mkdtempSync(join(tmpdir(), 'service-db-future-'));
    try {
      const future = new DatabaseSync(join(directory, 'future.sqlite'));
      future.exec('PRAGMA user_version=99');
      future.close();
      expect(() => new ServiceDatabase('future', directory)).toThrow('Unsupported database');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sweeps only due records and lets the caller postpone ones still in use', () => {
    const db = new ServiceDatabase('sweep', undefined);
    try {
      const store = db.store<{ busy: boolean }>('keys');
      store.insert('due-free', { busy: false }, 100);
      store.insert('due-busy', { busy: true }, 100);
      store.insert('later', { busy: false }, 10_000);
      store.insert('forever', { busy: false });
      const result = db.transaction(() =>
        store.sweep(500, 10, (_key, value) => (value.busy ? 5_000 : 'delete')),
      );
      expect(result).toEqual({ deleted: 1, postponed: 1 });
      expect(store.has('due-free')).toBe(false);
      expect(store.has('due-busy')).toBe(true);
      expect(db.transaction(() => store.sweep(1_000, 10, () => 'delete')).deleted).toBe(0);
      expect(store.scheduleUnscheduled(2_000)).toBe(1);
      expect(db.transaction(() => store.sweep(6_000, 10, () => 'delete')).deleted).toBe(2);
      expect(store.has('later')).toBe(true);
      // `set` without an expiry keeps the schedule; with one it replaces it.
      store.set('later', { busy: true });
      expect(db.transaction(() => store.sweep(9_999, 10, () => 'delete')).deleted).toBe(0);
      store.set('later', { busy: true }, 1);
      expect(db.transaction(() => store.sweep(9_999, 10, () => 'delete')).deleted).toBe(1);
    } finally {
      db.close();
    }
  });
});
