'use strict';

// Shared hosting (CloudLinux) counts every thread towards a small process limit. Node's default
// pool of 4 helper threads is more than this app needs. Must be set before anything uses the pool.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '2';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// Settings can live in a .env file next to package.json (hosting panels like cPanel start the app
// directly, so it's read here). Real environment variables win.
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const { openDb } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');
const { ensureOwner } = require('./services/accounts');
const { createOrg } = require('./services/orgSetup');
const { uniqueOrgCode } = require('./routes/auth');
const { utcNow } = require('./lib/dates');
const { version } = require('../package.json');

const env = process.env;
const ROOT = path.join(__dirname, '..');
const flag = (v) => /^(1|true|yes|on)$/i.test(v || '');
const RETRY_MS = 30000;

/** The database settings, or a list of what is missing. */
function dbConfig() {
  const client = (env.HR_DB_CLIENT || (env.HR_DB_NAME ? 'mysql' : 'sqlite')).toLowerCase();
  const dataDir = path.resolve(ROOT, env.HR_DATA_DIR || 'data');
  if (client === 'mysql') {
    const missing = ['HR_DB_NAME', 'HR_DB_USER', 'HR_DB_PASSWORD'].filter((k) => !env[k]);
    return {
      dataDir, missing,
      cfg: { client, host: env.HR_DB_HOST || 'localhost', port: env.HR_DB_PORT, user: env.HR_DB_USER, password: env.HR_DB_PASSWORD, database: env.HR_DB_NAME, socketPath: env.HR_DB_SOCKET },
    };
  }
  return { dataDir, missing: [], cfg: { client: 'sqlite', file: path.resolve(ROOT, env.HR_SQLITE_FILE || path.join(dataDir, 'hr.db')) } };
}

/**
 * While the app can't start (usually wrong database settings), answer every request with the
 * reason instead of crashing: a crash makes the web server restart the app over and over, which
 * uses up the hosting account's process limit and only ever shows a blank 404/503.
 */
function problemHandler(problem) {
  return (req, res) => {
    if (req.url.startsWith('/api/health')) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, version, problem }));
      return;
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Broadwing HR is not ready</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 20px;color:#1f2937">
<h1 style="font-size:22px">Broadwing HR is installed but not ready yet</h1>
<p style="background:#fef2f2;color:#991b1b;padding:12px 14px;border-radius:10px">${esc(problem)}</p>
<p>Fix the setting in cPanel → Setup Node.js App → Environment variables, click Save, then Restart.
The app also tries again by itself every 30 seconds.</p></body>`);
  };
}

/**
 * When the owner comes from the settings (not the first-run screen), also make the first
 * organization, so signing in opens a working workspace instead of an empty screen.
 */
async function ensureFirstOrg(db) {
  if (Number(await db.value('SELECT COUNT(*) AS n FROM orgs'))) return;
  const owner = env.HR_OWNER_USERNAME && await db.get('SELECT id FROM users WHERE username = ?', [String(env.HR_OWNER_USERNAME).trim().toLowerCase()]);
  if (!owner) return;
  const name = (env.HR_ORG_NAME || 'My organization').slice(0, 150);
  const orgId = await createOrg(db, { name, code: await uniqueOrgCode(db, name) });
  await db.insert('memberships', { user_id: owner.id, org_id: orgId, role: 'admin', created_at: utcNow() });
  console.log(`Created the organization "${name}". Rename it under Settings → Company profile.`);
}

async function main() {
  let handler = problemHandler('Starting…');
  const server = http.createServer((req, res) => handler(req, res));
  const port = Number(env.PORT) || 3100;
  server.listen(port, env.HOST || '0.0.0.0', () => console.log(`Broadwing HR ${version} is listening on port ${port}`));

  const { cfg, dataDir, missing } = dbConfig();
  for (;;) {
    let db = null;
    try {
      if (missing.length) throw new Error(`Missing setting${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
      db = await openDb(cfg);
      const app = await createApp({
        db,
        dataDir,
        trustProxy: env.TRUST_PROXY && env.TRUST_PROXY !== '0' ? Number(env.TRUST_PROXY) || env.TRUST_PROXY : false,
        signup: flag(env.HR_SIGNUP ?? 'off'),
        ssoSecret: env.BROADWING_SSO_SECRET || null,
      });
      const msg = await ensureOwner(db, {
        username: env.HR_OWNER_USERNAME, password: env.HR_OWNER_PASSWORD, name: env.HR_OWNER_NAME, resetPassword: flag(env.HR_OWNER_RESET_PASSWORD),
      });
      if (msg) console.log(msg);
      await ensureFirstOrg(db);
      startScheduler(db, { dataDir });
      handler = app;
      console.log(cfg.client === 'mysql' ? `Database: MySQL ${cfg.database} on ${cfg.host}` : `Database: SQLite file ${cfg.file}`);
      return;
    } catch (err) {
      const problem = cfg.client === 'mysql' && /access denied|ER_ACCESS|ER_DBACCESS|ER_BAD_DB/i.test(`${err.code} ${err.message}`)
        ? `The database refused the connection: ${err.message}. Check HR_DB_NAME, HR_DB_USER and HR_DB_PASSWORD, and that the user is added to the database with all privileges.`
        : err.message;
      console.error(`Broadwing HR could not start: ${problem}`);
      handler = problemHandler(problem);
      if (db) { try { await db.close(); } catch { /* already closed */ } }
      if (missing.length) return; // settings only change with a restart
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

main().catch((err) => {
  console.error(`Broadwing HR could not start: ${err.message}`);
  process.exit(1);
});
