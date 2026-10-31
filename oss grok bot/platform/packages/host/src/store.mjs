import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const callNonce = (run, call) => {
  const hex = createHash('sha256')
    .update(run + ':' + call)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    'a' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
};
export class Failure extends Error {
  constructor(tag, message, status = 400) {
    super(message);
    this.tag = tag;
    this.status = status;
  }
}
export const fail = (tag, message, status) => {
  throw new Failure(tag, message, status);
};
export class Store {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, 'product.sqlite');
    const existed = existsSync(file);
    this.db = new DatabaseSync(file);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) {
      this.db.close();
      fail(
        'unsupported_version',
        'Database is newer than this application. No migration performed.',
        409,
      );
    }
    if (existed && version === 0 && !existsSync(file + '.pre-v1.bak'))
      this.db.exec(`VACUUM INTO '${(file + '.pre-v1.bak').replaceAll("'", "''")}'`);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,bot TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind_bot ON records(kind,bot);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,bot TEXT,run TEXT,type TEXT,data TEXT,at INTEGER);
      CREATE TABLE IF NOT EXISTS nonces(scope TEXT,nonce TEXT,run TEXT,PRIMARY KEY(scope,nonce));
      CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,sealed TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  get(key, kind) {
    const row = this.db.prepare('SELECT data,kind FROM records WHERE id=?').get(key);
    if (!row || (kind && row.kind !== kind)) fail('not_found', 'Resource not found', 404);
    return JSON.parse(row.data);
  }
  list(kind, bot) {
    return (
      bot === undefined
        ? this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind)
        : this.db.prepare('SELECT data FROM records WHERE kind=? AND bot=?').all(kind, bot)
    ).map((r) => JSON.parse(r.data));
  }
  put(kind, value, expected) {
    const old = this.db.prepare('SELECT data FROM records WHERE id=?').get(value.id);
    const prior = old ? JSON.parse(old.data) : null;
    if (expected !== undefined && prior?.revision !== expected)
      fail('stale_revision', 'This record changed. Refresh before saving.', 409);
    const row = {
      ...value,
      revision: (prior?.revision ?? 0) + 1,
      createdAt: prior?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(row.id, kind, row.botId ?? null, JSON.stringify(row));
    return row;
  }
  event(bot, run, type, data) {
    const event = {
      id: id(),
      schemaVersion: 1,
      source: 'host',
      bot,
      run,
      type,
      data,
      at: Date.now(),
    };
    const result = this.db
      .prepare('INSERT INTO events(id,bot,run,type,data,at) VALUES(?,?,?,?,?,?)')
      .run(event.id, bot ?? null, run ?? null, type, JSON.stringify(event), event.at);
    return { ...event, seq: Number(result.lastInsertRowid) };
  }
  events(cursor = 0, bot) {
    const rows = bot
      ? this.db
          .prepare('SELECT seq,data FROM events WHERE seq>? AND bot=? ORDER BY seq LIMIT 250')
          .all(cursor, bot)
      : this.db
          .prepare('SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT 250')
          .all(cursor);
    return rows.map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
  }
  close() {
    this.db.close();
  }
}
