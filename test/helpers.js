'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');

/**
 * Start the app on a random port with a fresh database: SQLite in memory by default, or a fresh
 * MySQL database when HR_TEST_MYSQL is set (e.g. HR_TEST_MYSQL=mysql://user:pass@localhost).
 */
async function startServer(opts = {}) {
  let db;
  let dropDb = null;
  if (process.env.HR_TEST_MYSQL) {
    const url = new URL(process.env.HR_TEST_MYSQL);
    const name = `hr_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const mysql = require('mysql2/promise');
    const admin = await mysql.createConnection({ host: url.hostname, port: url.port || 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`);
    db = await openDb({ client: 'mysql', host: url.hostname, port: url.port || 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: name });
    dropDb = async () => { await admin.query(`DROP DATABASE ${name}`); await admin.end(); };
  } else {
    db = await openDb({ client: 'sqlite', file: ':memory:' });
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-test-'));
  const app = await createApp({ db, dataDir, signup: true, ssoSecret: 'test-secret', ...opts });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, base,
    async close() {
      await new Promise((r) => server.close(r));
      await db.close();
      if (dropDb) await dropDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A tiny client that keeps its own cookie, like a browser. */
function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  }
  const ok = async (method, url, body) => {
    const r = await call(method, url, body);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return {
    call,
    get: (u) => ok('GET', u),
    post: (u, b = {}) => ok('POST', u, b),
    put: (u, b = {}) => ok('PUT', u, b),
    del: (u) => ok('DELETE', u),
    get cookie() { return cookie; },
  };
}

module.exports = { startServer, client };
