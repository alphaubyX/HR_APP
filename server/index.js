'use strict';

const fs = require('node:fs');
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

const env = process.env;
const ROOT = path.join(__dirname, '..');
const flag = (v) => /^(1|true|yes|on)$/i.test(v || '');

async function main() {
  const client = (env.HR_DB_CLIENT || (env.HR_DB_NAME ? 'mysql' : 'sqlite')).toLowerCase();
  const dataDir = path.resolve(ROOT, env.HR_DATA_DIR || 'data');
  const dbCfg = client === 'mysql'
    ? { client, host: env.HR_DB_HOST || 'localhost', port: env.HR_DB_PORT, user: env.HR_DB_USER, password: env.HR_DB_PASSWORD, database: env.HR_DB_NAME, socketPath: env.HR_DB_SOCKET }
    : { client: 'sqlite', file: path.resolve(ROOT, env.HR_SQLITE_FILE || path.join(dataDir, 'hr.db')) };
  const db = await openDb(dbCfg);
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
  startScheduler(db);
  const port = Number(env.PORT) || 3100;
  app.listen(port, env.HOST || '0.0.0.0', () => {
    console.log(`Broadwing HR is running on http://localhost:${port}`);
    console.log(client === 'mysql' ? `Database: MySQL ${dbCfg.database} on ${dbCfg.host}` : `Database: SQLite file ${dbCfg.file}`);
  });
}

main().catch((err) => {
  console.error(`Broadwing HR could not start: ${err.message}`);
  process.exit(1);
});
