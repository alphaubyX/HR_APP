'use strict';

const path = require('node:path');
const express = require('express');
const { migrate } = require('./db/migrate');
const { HttpError } = require('./lib/validate');
const { sha256, ROLES } = require('./lib/auth');
const { roleInfo } = require('./services/roles');
const workflows = require('./services/workflows');
const { utcNow, utcPlus } = require('./lib/dates');
const { orgSettings } = require('./engine/policy');

const COOKIE = 'bwhr_session';
const SESSION_DAYS = 30;

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Build the Express app around an open database.
 * options: { db, trustProxy, signup, dataDir, owner: { username, password, name, resetPassword }, ssoSecret }
 */
async function createApp(options) {
  const { db } = options;
  await migrate(db);

  const app = express();
  app.locals.db = db;
  app.locals.options = options;
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'self'",
      ].join('; '),
    });
    next();
  });

  // Attendance machines (ZKTeco "ADMS" push) talk plain text at /iclock, before any JSON parsing.
  app.use('/iclock', express.text({ type: () => true, limit: '5mb' }), require('./routes/iclock')(db));

  // Answers depend on who is signed in and change all the time: never let the browser, the web
  // server (e.g. LiteSpeed cache on shared hosting) or a proxy keep a copy.
  app.use('/api', (req, res, next) => { res.set({ 'Cache-Control': 'no-store, private', 'X-LiteSpeed-Cache-Control': 'no-cache' }); next(); });
  app.use('/api', express.json({ limit: '8mb' }));

  /* Who is calling: a session cookie (web) or a bearer token (phone app / integrations). */
  app.use('/api', async (req, res, next) => {
    req.db = db;
    req.perms = new Set();
    if (req[workflows.INTERNAL]) { // an approved request being carried out in its initiator's name
      const { userId, orgId } = req[workflows.INTERNAL];
      req.user = await db.get('SELECT id, username, email, name, is_owner, active, last_org_id FROM users WHERE id = ?', [userId]);
      if (req.user) await openOrg(req, orgId);
      return next();
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : readCookie(req, COOKIE);
    if (!token) return next();
    const session = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [sha256(token)]);
    if (!session || session.expires_at < utcNow()) return next();
    const user = await db.get('SELECT id, username, email, name, is_owner, active, last_org_id FROM users WHERE id = ?', [session.user_id]);
    if (!user || !user.active) return next();
    req.session = session;
    req.sessionToken = token;
    req.user = user;
    if (session.org_id) await openOrg(req, session.org_id);
    // keep a lasting session alive while it's used
    if (session.expires_at < utcPlus((SESSION_DAYS - 1) * 86400000)) {
      const expires = utcPlus(SESSION_DAYS * 86400000);
      await db.update('sessions', { id: session.id }, { expires_at: expires });
      if (!header.startsWith('Bearer ')) setCookie(req, res, token);
    }
    next();
  });

  /** The organization the user works in, their membership and the rights of their role. */
  async function openOrg(req, orgId) {
    const { user } = req;
    const org = await db.get('SELECT * FROM orgs WHERE id = ?', [orgId]);
    let member = org ? await db.get('SELECT * FROM memberships WHERE user_id = ? AND org_id = ? AND active = 1', [user.id, org.id]) : null;
    if (org && !member && user.is_owner) member = { role: 'admin', employee_id: null, support: true }; // server owner helping a customer
    if (org && member && (org.status === 'active' || user.is_owner)) {
      org.settings = orgSettings(org.settings);
      req.org = org;
      req.member = member;
      const role = await roleInfo(db, org.id, member.role);
      req.perms = role.perms;
      req.roleName = role.name;
    }
  }

  function setCookie(req, res, token) {
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_DAYS * 86400000,
    });
  }
  app.locals.setCookie = setCookie;
  app.locals.clearCookie = (res) => res.clearCookie(COOKIE, { path: '/' });
  app.locals.SESSION_DAYS = SESSION_DAYS;

  const ctx = { db, options, setCookie, COOKIE, SESSION_DAYS, ROLES, app };
  // actions with an approval workflow switched on are kept for approval instead of being done
  app.use('/api', workflows.gate(ctx));
  // Listed one by one (not loaded by name) so the single-file build for hosting includes them all.
  const routers = [
    require('./routes/auth'), require('./routes/platform'), require('./routes/org'), require('./routes/employees'),
    require('./routes/salary'), require('./routes/leave'), require('./routes/attendance'), require('./routes/payroll'),
    require('./routes/reports'), require('./routes/workflows'),
  ];
  for (const register of routers) {
    const router = express.Router();
    register(router, ctx);
    app.use('/api', router);
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, {
    setHeaders(res, file) {
      // the app shell must update right away after a deploy; images may be cached
      if (/\.(html|js|css|webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api\/|iclock\/).*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    if (err.code === 'ER_DUP_ENTRY' || /UNIQUE constraint failed/.test(err.message)) {
      return res.status(409).json({ error: 'That already exists (a code or number must be unique).' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

  return app;
}

module.exports = { createApp, COOKIE };
