'use strict';

/**
 * One small async database API on top of two engines:
 *  - MySQL / MariaDB (production, e.g. the MySQL database on FastComet), through mysql2.
 *  - SQLite (local trials and tests), through Node's built-in node:sqlite.
 *
 * All SQL in the app is written to run on both: "?" placeholders, no engine-specific functions,
 * dates kept as 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' strings and date maths done in JavaScript.
 */

const fs = require('node:fs');
const path = require('node:path');

function cleanParams(params = []) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
    return v;
  });
}

class Db {
  constructor(dialect) {
    this.dialect = dialect;
  }

  async get(sql, params) {
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }

  async value(sql, params) {
    const row = await this.get(sql, params);
    return row ? Object.values(row)[0] : null;
  }

  /** Insert an object; returns the new id. */
  async insert(table, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    const r = await this.run(sql, keys.map((k) => obj[k]));
    return r.id;
  }

  /** Insert unless it would break a unique index; returns the new id, or null if it was a duplicate. */
  async insertIgnore(table, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const verb = this.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
    const sql = `${verb} INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    const r = await this.run(sql, keys.map((k) => obj[k]));
    return r.changes ? r.id : null;
  }

  /** Update columns of one row, scoped by `where` (an object of column = value). */
  async update(table, where, obj) {
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    if (!keys.length) return 0;
    const wk = Object.keys(where);
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${wk.map((k) => `${k} = ?`).join(' AND ')}`;
    const r = await this.run(sql, [...keys.map((k) => obj[k]), ...wk.map((k) => where[k])]);
    return r.changes;
  }

  /** "id IN (?, ?, ?)" helper. Returns [sqlFragment, params]; an empty list matches nothing. */
  static inList(column, values) {
    if (!values.length) return ['1 = 0', []];
    return [`${column} IN (${values.map(() => '?').join(', ')})`, values];
  }
}

/* ------------------------------------------------------------------ MySQL */

class MysqlDb extends Db {
  constructor(pool, conn = null) {
    super('mysql');
    this.pool = pool;
    this.conn = conn;
  }

  async all(sql, params) {
    const [rows] = await (this.conn || this.pool).query(sql, cleanParams(params));
    return rows;
  }

  async run(sql, params) {
    const [r] = await (this.conn || this.pool).query(sql, cleanParams(params));
    return { id: r.insertId, changes: r.affectedRows };
  }

  async exec(sql) {
    for (const stmt of splitStatements(sql)) await (this.conn || this.pool).query(stmt);
  }

  async tx(fn) {
    if (this.conn) return fn(this); // already inside a transaction
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(new MysqlDb(this.pool, conn));
      await conn.commit();
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch { /* connection may be gone */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

/* ----------------------------------------------------------------- SQLite */

class SqliteDb extends Db {
  constructor(raw, shared = null, inTx = false) {
    super('sqlite');
    this.raw = raw;
    // node:sqlite is synchronous, but our transactions await between statements. A queue makes
    // other requests wait until a running transaction has finished, so they never interleave.
    this.shared = shared || { lock: Promise.resolve() };
    this.inTx = inTx;
  }

  async waitTurn() {
    if (!this.inTx) await this.shared.lock;
  }

  async all(sql, params) {
    await this.waitTurn();
    return this.raw.prepare(sql).all(...cleanParams(params)).map((r) => ({ ...r }));
  }

  async run(sql, params) {
    await this.waitTurn();
    const r = this.raw.prepare(sql).run(...cleanParams(params));
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  async exec(sql) {
    await this.waitTurn();
    this.raw.exec(sql);
  }

  async tx(fn) {
    if (this.inTx) return fn(this);
    let release;
    const previous = this.shared.lock;
    this.shared.lock = new Promise((r) => { release = r; });
    await previous;
    const txDb = new SqliteDb(this.raw, this.shared, true);
    this.raw.exec('BEGIN');
    try {
      const result = await fn(txDb);
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    } finally {
      release();
    }
  }

  async close() {
    this.raw.close();
  }
}

function splitStatements(sql) {
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * cfg: { client: 'mysql', host, port, user, password, database } or { client: 'sqlite', file }.
 */
async function openDb(cfg) {
  if (cfg.client === 'mysql') {
    let mysql;
    try { mysql = require('mysql2/promise'); } catch {
      throw new Error('The mysql2 package is missing: run "npm install".');
    }
    const pool = mysql.createPool({
      host: cfg.host || 'localhost',
      port: Number(cfg.port) || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      socketPath: cfg.socketPath || undefined,
      connectionLimit: Number(cfg.connectionLimit) || 5,
      waitForConnections: true,
      dateStrings: true, // DATE → 'YYYY-MM-DD', DATETIME → 'YYYY-MM-DD HH:MM:SS'
      decimalNumbers: true, // DECIMAL → number
      timezone: 'Z',
      charset: 'utf8mb4',
    });
    const db = new MysqlDb(pool);
    try {
      await db.all('SELECT 1');
    } catch (err) {
      await pool.end().catch(() => {}); // don't leave a half-open pool behind when retrying
      throw err;
    }
    return db;
  }
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch {
    throw new Error('SQLite needs Node.js 22.13 or newer. Use MySQL (HR_DB_CLIENT=mysql) on older Node versions.');
  }
  const file = cfg.file || ':memory:';
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  return new SqliteDb(raw);
}

module.exports = { openDb, Db, inList: Db.inList };
