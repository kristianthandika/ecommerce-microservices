import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
export type { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Supports mounted Docker/Kubernetes secrets without embedding values in images. */
export function readSecret(name: string): string {
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, 'utf8').trim() : (process.env[name] ?? '');
}

/**
 * Ordered schema migrations. Entry `n` upgrades `user_version` n → n+1 and runs in
 * its own transaction together with the version bump, so a crash never leaves a
 * half-applied step. Never edit a released step: append a new one instead.
 */
const MIGRATIONS: readonly ((db: DatabaseSync) => void)[] = [
  // v1: one key/value table per service database.
  (db) =>
    db.exec(
      'CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))',
    ),
  // v2: optional deletion schedule, used by retention jobs.
  (db) =>
    db.exec(
      'ALTER TABLE records ADD COLUMN expires_at INTEGER; CREATE INDEX records_expiry ON records(expires_at) WHERE expires_at IS NOT NULL;',
    ),
  // v3: ledger of service-owned migrations (relational tables live next to `records`).
  (db) =>
    db.exec(
      'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT',
    ),
];
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * A schema change owned by one service, for example a relational table that replaces
 * a key/value namespace. Applied once, in list order, each in its own transaction
 * together with its ledger row. Never edit or rename a released migration: append one.
 */
export interface ServiceMigration {
  readonly name: string;
  up(db: DatabaseSync): void;
}
export interface DatabaseOptions {
  directory?: string;
  migrations?: readonly ServiceMigration[];
}

/** One SQLite database per service; tests use an isolated in-memory database. */
export class ServiceDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  /** `directoryOrOptions` as a string is the data directory (kept for existing callers). */
  constructor(service: string, directoryOrOptions?: string | DatabaseOptions) {
    const options =
      typeof directoryOrOptions === 'object'
        ? directoryOrOptions
        : { directory: directoryOrOptions };
    const directory =
      options.directory ??
      process.env.DATA_DIR ??
      (process.env.NODE_ENV === 'test' ? undefined : './data');
    if (directory) mkdirSync(directory, { recursive: true });
    const file = directory ? join(directory, `${service}.sqlite`) : ':memory:';
    this.db = new DatabaseSync(file);
    try {
      this.migrate(file, options.migrations ?? []);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private migrate(file: string, serviceMigrations: readonly ServiceMigration[]): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > SCHEMA_VERSION)
      throw new Error(
        `Unsupported database schema version: ${version} (this build supports ${SCHEMA_VERSION})`,
      );
    // Foreign keys are off by default in SQLite and the setting is per connection.
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
    );
    const names = serviceMigrations.map((migration) => migration.name);
    if (new Set(names).size !== names.length) throw new Error('Duplicate service migration name');
    const applied = new Set(
      version >= 3
        ? this.db
            .prepare('SELECT name FROM schema_migrations')
            .all()
            .map((row) => String(row.name))
        : [],
    );
    // A migration this build does not know means a newer release wrote the file;
    // running older code against it could silently corrupt data.
    const unknown = [...applied].filter((name) => !names.includes(name));
    if (unknown.length)
      throw new Error(`Unsupported database schema: unknown migration ${unknown.join(', ')}`);
    const pending = serviceMigrations.filter((migration) => !applied.has(migration.name));
    if (version === SCHEMA_VERSION && !pending.length) return;
    // Existing data gets a consistent copy before it is touched. VACUUM INTO is
    // synchronous and works on a live WAL database.
    if (version > 0 && file !== ':memory:') {
      const label = version < SCHEMA_VERSION ? `v${version + 1}` : pending[0].name;
      const target = `${file}.pre-${label}-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    }
    for (let step = version; step < SCHEMA_VERSION; step++) {
      this.transaction(() => {
        MIGRATIONS[step](this.db);
        this.db.exec(`PRAGMA user_version=${step + 1}`);
      });
    }
    const record = this.db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?,?)');
    for (const migration of pending) {
      this.transaction(() => {
        migration.up(this.db);
        record.run(migration.name, new Date().toISOString());
      });
    }
  }

  /** Names of the service migrations applied to this database, in application order. */
  get appliedMigrations(): string[] {
    return this.db
      .prepare('SELECT name FROM schema_migrations ORDER BY applied_at, rowid')
      .all()
      .map((row) => String(row.name));
  }
  /**
   * Prepared statement for a service-owned table, compiled once per database.
   * Always bind values as parameters; never interpolate them into `sql`.
   */
  statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get schemaVersion(): number {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
  }
  store<T>(namespace: string): Store<T> {
    return new Store<T>(this.db, namespace);
  }
  /**
   * Runs `fn` atomically. The callback MUST be synchronous: an async callback would
   * commit before its awaited work finishes, silently losing atomicity. A call made
   * while a transaction is already open joins it instead of failing on a nested BEGIN.
   */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function')
        throw new TypeError('Transaction callbacks must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      // A failed ROLLBACK must never hide the error that caused it.
      try {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch {
        /* the original error is more useful to the caller */
      }
      throw err;
    }
  }
  close(): void {
    this.db.close();
  }
  async backup(path: string): Promise<void> {
    await backup(this.db, path);
  }
}

/** `undefined` keeps the current schedule; `null` clears it; a number is epoch ms. */
export type Expiry = number | null | undefined;
/** What a sweep does with an expired record: delete it, or postpone to a new time. */
export type SweepDecision = 'delete' | number;

export class Store<T> {
  private readonly statements = new Map<string, StatementSync>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly namespace: string,
  ) {}
  /** Statements are compiled once per store instead of on every call. */
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  /**
   * Reads ignore `expires_at`: it is a deletion schedule for retention jobs, not a
   * visibility rule. Callers that need freshness check it in their own data.
   */
  get(key: string): T | undefined {
    const row = this.statement('SELECT value FROM records WHERE namespace=? AND key=?').get(
      this.namespace,
      key,
    );
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  has(key: string): boolean {
    return (
      this.statement('SELECT 1 AS found FROM records WHERE namespace=? AND key=?').get(
        this.namespace,
        key,
      ) !== undefined
    );
  }
  set(key: string, value: T, expiresAt?: Expiry): void {
    if (expiresAt === undefined)
      this.statement(
        'INSERT INTO records (namespace,key,value) VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value',
      ).run(this.namespace, key, JSON.stringify(value));
    else
      this.statement(
        'INSERT INTO records (namespace,key,value,expires_at) VALUES (?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at',
      ).run(this.namespace, key, JSON.stringify(value), expiresAt);
  }
  insert(key: string, value: T, expiresAt: number | null = null): boolean {
    return (
      this.statement(
        'INSERT INTO records (namespace,key,value,expires_at) VALUES (?,?,?,?) ON CONFLICT(namespace,key) DO NOTHING',
      ).run(this.namespace, key, JSON.stringify(value), expiresAt).changes === 1
    );
  }
  values(): T[] {
    return this.statement('SELECT value FROM records WHERE namespace=? ORDER BY key')
      .all(this.namespace)
      .map((row) => JSON.parse(String(row.value)) as T);
  }
  get size(): number {
    return Number(
      this.statement('SELECT count(*) AS count FROM records WHERE namespace=?').get(this.namespace)
        ?.count,
    );
  }
  delete(key: string): void {
    this.statement('DELETE FROM records WHERE namespace=? AND key=?').run(this.namespace, key);
  }
  clear(): void {
    this.statement('DELETE FROM records WHERE namespace=?').run(this.namespace);
  }
  /** Schedules records that have no deletion time yet (legacy rows). Returns the count. */
  scheduleUnscheduled(expiresAt: number): number {
    return Number(
      this.statement(
        'UPDATE records SET expires_at=? WHERE namespace=? AND expires_at IS NULL',
      ).run(expiresAt, this.namespace).changes,
    );
  }
  /**
   * Processes up to `limit` records whose schedule is due. `decide` sees each one and
   * either lets it go or postpones it — retention never deletes something a caller
   * still needs. Call inside `ServiceDatabase.transaction` for an atomic batch.
   */
  sweep(
    now: number,
    limit: number,
    decide: (key: string, value: T) => SweepDecision,
  ): { deleted: number; postponed: number } {
    const due = this.statement(
      'SELECT key, value FROM records WHERE namespace=? AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT ?',
    ).all(this.namespace, now, limit);
    let deleted = 0;
    let postponed = 0;
    for (const row of due) {
      const key = String(row.key);
      const decision = decide(key, JSON.parse(String(row.value)) as T);
      if (decision === 'delete') {
        this.delete(key);
        deleted++;
      } else {
        this.statement('UPDATE records SET expires_at=? WHERE namespace=? AND key=?').run(
          Math.max(decision, now + 1),
          this.namespace,
          key,
        );
        postponed++;
      }
    }
    return { deleted, postponed };
  }
}
