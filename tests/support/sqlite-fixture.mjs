import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class SqliteStatement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new SqliteStatement(this.database, this.sql, params);
  }
  async first() {
    this.database.executed.push(this.sql);
    const row = this.database.sqlite.prepare(this.sql).get(...this.params) ?? null;
    if (this.database.afterRead && this.database.readMatch?.test(this.sql)) {
      const callback = this.database.afterRead;
      this.database.afterRead = null;
      await callback();
    }
    return row;
  }
  async all() {
    this.database.executed.push(this.sql);
    return { results: this.database.sqlite.prepare(this.sql).all(...this.params), success: true };
  }
  async run() {
    this.database.executed.push(this.sql);
    const result = this.database.sqlite.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

/** In-memory SQLite contract for API tests; real PostgreSQL behavior is tested separately. */
export class SqliteTestDatabase {
  executed = [];
  beforeBatch = null;
  hook = null;
  afterRead = null;
  readMatch = null;
  constructor({ initialize } = {}) {
    this.sqlite = new DatabaseSync(':memory:');
    if (initialize) {
      initialize(this.sqlite);
      return;
    }
    const directory = new URL('../../drizzle/', import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort())
      this.sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../../db/guards.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    return new SqliteStatement(this, sql);
  }
  async batch(statements) {
    for (const key of ['beforeBatch', 'hook']) {
      const callback = this[key];
      if (callback) {
        this[key] = null;
        await callback(statements);
      }
    }
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => {
        this.executed.push(statement.sql);
        return {
          results: this.sqlite.prepare(statement.sql).all(...statement.params),
          success: true,
        };
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.sqlite.close();
  }
}

export class MemoryObjectStore {
  data = new Map();
  async put(key, value) {
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.data.set(key, bytes);
    return { key };
  }
  async get(key) {
    const bytes = this.data.get(key);
    return bytes
      ? {
          size: bytes.length,
          body: new Response(bytes).body,
          text: async () => new TextDecoder().decode(bytes),
        }
      : null;
  }
  async head(key) {
    const bytes = this.data.get(key);
    return bytes ? { size: bytes.length } : null;
  }
  async delete(key) {
    this.data.delete(key);
  }
}
