'use strict';

const crypto = require('node:crypto');
const { verifyPassword, hashPassword, sha256, ROLES } = require('../lib/auth');
const { pick, bad, HttpError } = require('../lib/validate');
const { utcNow } = require('../lib/dates');
const { createUser, startSession, defaultOrg, checkPassword, cleanUsername } = require('../services/accounts');
const { createOrg } = require('../services/orgSetup');
const { fullName } = require('../services/common');

function orgCode(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'org';
}

async function uniqueOrgCode(db, name) {
  const base = orgCode(name);
  let code = base;
  for (let i = 2; await db.get('SELECT id FROM orgs WHERE code = ?', [code]); i++) code = `${base}-${i}`;
  return code;
}

module.exports = function authRoutes(r, { db, options, setCookie, SESSION_DAYS }) {
  const attempts = new Map();
  function throttle(key) {
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
    if (list.length >= 10) throw new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes.');
    list.push(now);
    attempts.set(key, list);
  }

  async function mePayload(req) {
    const user = req.user;
    const orgs = user.is_owner
      ? await db.all("SELECT id, name, code, status FROM orgs ORDER BY name")
      : await db.all(
        `SELECT o.id, o.name, o.code, o.status, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id
         WHERE m.user_id = ? AND m.active = 1 ORDER BY o.name`, [user.id]);
    let employee = null;
    if (req.member && req.member.employee_id) {
      const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [req.member.employee_id, req.org.id]);
      if (e) {
        const reports = await db.value("SELECT COUNT(*) AS n FROM employees WHERE org_id = ? AND manager_id = ? AND status <> 'exited'", [req.org.id, e.id]);
        employee = {
          id: e.id, name: fullName(e), emp_code: e.emp_code, photo: e.photo, status: e.status, remote_attendance: e.remote_attendance,
          gender: e.gender, direct_reports: Number(reports) || 0, join_date: e.join_date,
        };
      }
    }
    const unread = req.org ? Number(await db.value('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND org_id = ? AND read_at IS NULL', [user.id, req.org.id])) : 0;
    return {
      user: { id: user.id, username: user.username, name: user.name, email: user.email, is_owner: !!user.is_owner },
      org: req.org ? {
        id: req.org.id, name: req.org.name, code: req.org.code, currency: req.org.currency, timezone: req.org.timezone, logo: req.org.logo,
        settings: req.org.settings, plan: req.org.plan, status: req.org.status,
      } : null,
      role: req.member ? req.member.role : null,
      roleLabel: req.member ? (ROLES[req.member.role] || ROLES.employee).label : null,
      support: !!(req.member && req.member.support),
      perms: [...req.perms],
      employee,
      orgs,
      unread,
    };
  }

  /** For the deploy workflow and uptime monitors: is the app up and can it reach its database? */
  r.get('/health', async (req, res) => {
    await db.value('SELECT 1');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, version: require('../../package.json').version, database: db.dialect });
  });

  r.get('/setup', async (req, res) => {
    const users = Number(await db.value('SELECT COUNT(*) AS n FROM users'));
    res.json({ needsSetup: users === 0, signup: !!options.signup });
  });

  // First start on an empty database: create the owner and their organization.
  r.post('/setup', async (req, res) => {
    if (Number(await db.value('SELECT COUNT(*) AS n FROM users'))) throw bad('Setup is already done.');
    const b = pick(req.body, { name: ['str', { required: true, max: 150 }], org_name: ['str', { required: true, max: 150 }] });
    const userId = await createUser(db, { username: req.body.username, name: b.name, password: req.body.password, isOwner: true });
    const orgId = await createOrg(db, { name: b.org_name, code: await uniqueOrgCode(db, b.org_name) });
    await db.insert('memberships', { user_id: userId, org_id: orgId, role: 'admin', created_at: utcNow() });
    const token = await startSession(db, userId, orgId, 'web', req.headers['user-agent'], SESSION_DAYS);
    setCookie(req, res, token);
    res.json({ ok: true });
  });

  r.post('/signup', async (req, res) => {
    if (!options.signup) throw bad('New sign-ups are closed. Please contact us.');
    throttle(`signup|${req.ip}`);
    const b = pick(req.body, {
      name: ['str', { required: true, max: 150 }], org_name: ['str', { required: true, max: 150 }], email: ['email', { required: true }],
    });
    checkPassword(req.body.password);
    const uname = cleanUsername(req.body.username);
    if (await db.get('SELECT id FROM users WHERE username = ?', [uname])) throw bad('That username is taken.');
    const orgId = await createOrg(db, { name: b.org_name, code: await uniqueOrgCode(db, b.org_name) });
    const userId = await createUser(db, { username: uname, name: b.name, email: b.email, password: req.body.password });
    await db.insert('memberships', { user_id: userId, org_id: orgId, role: 'admin', created_at: utcNow() });
    const token = await startSession(db, userId, orgId, 'web', req.headers['user-agent'], SESSION_DAYS);
    setCookie(req, res, token);
    res.json({ ok: true });
  });

  r.post('/login', async (req, res) => {
    const login = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    throttle(`login|${req.ip}|${login}`);
    const user = login.includes('@')
      ? await db.get('SELECT * FROM users WHERE email = ? AND active = 1', [login])
      : await db.get('SELECT * FROM users WHERE username = ? AND active = 1', [login]);
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Wrong username or password.');
    const orgId = await defaultOrg(db, user);
    if (!orgId && !user.is_owner) throw new HttpError(403, 'Your account is not active in any organization. Please contact HR.');
    const kind = req.body?.device === 'mobile' ? 'mobile' : 'web';
    const token = await startSession(db, user.id, orgId, kind, req.headers['user-agent'], kind === 'mobile' ? 365 : SESSION_DAYS);
    if (kind === 'web') setCookie(req, res, token);
    res.json(kind === 'mobile' ? { token } : { ok: true });
  });

  /**
   * Single sign-on from the Broadwing suite: Broadwing sends the user here with a short-lived token
   * signed with BROADWING_SSO_SECRET. Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256).
   * Payload: { "u": "username or email", "org": "org code (optional)", "exp": unix seconds }.
   */
  r.get('/sso/broadwing', async (req, res) => {
    const secret = options.ssoSecret;
    if (!secret) throw new HttpError(404, 'Single sign-on is not set up.');
    const [body, sig] = String(req.query.token || '').split('.');
    if (!body || !sig) throw bad('Missing sign-in token.');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new HttpError(401, 'The sign-in link is not valid.');
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw bad('The sign-in link is not valid.'); }
    if (!payload.exp || payload.exp * 1000 < Date.now()) throw new HttpError(401, 'The sign-in link has expired.');
    const login = String(payload.u || '').toLowerCase();
    const user = await db.get('SELECT * FROM users WHERE (username = ? OR email = ?) AND active = 1', [login, login]);
    if (!user) throw new HttpError(401, 'No HR account matches your Broadwing account.');
    let orgId = await defaultOrg(db, user);
    if (payload.org) {
      const org = await db.get('SELECT id FROM orgs WHERE code = ?', [String(payload.org)]);
      if (org && (user.is_owner || await db.get('SELECT id FROM memberships WHERE user_id = ? AND org_id = ? AND active = 1', [user.id, org.id]))) orgId = org.id;
    }
    const token = await startSession(db, user.id, orgId, 'web', req.headers['user-agent'], SESSION_DAYS);
    setCookie(req, res, token);
    res.redirect('/');
  });

  r.post('/logout', async (req, res) => {
    if (req.sessionToken) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(req.sessionToken)]);
    req.app.locals.clearCookie(res);
    res.json({ ok: true });
  });

  const signedIn = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));

  r.get('/me', signedIn, async (req, res) => res.json(await mePayload(req)));

  r.put('/me', signedIn, async (req, res) => {
    const b = pick(req.body, { name: ['str', { required: true, max: 150 }], email: ['email'] });
    if (b.email && await db.get('SELECT id FROM users WHERE email = ? AND id <> ?', [b.email, req.user.id])) throw bad('That email is used by another account.');
    await db.update('users', { id: req.user.id }, b);
    res.json({ ok: true });
  });

  r.put('/me/password', signedIn, async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(String(req.body?.current || ''), user.password_hash)) throw bad('Your current password is not right.');
    await db.update('users', { id: user.id }, { password_hash: hashPassword(checkPassword(req.body?.password)) });
    // sign out other devices
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [user.id, sha256(req.sessionToken)]);
    res.json({ ok: true });
  });

  r.post('/me/org', signedIn, async (req, res) => {
    const orgId = Number(req.body?.orgId);
    const org = await db.get('SELECT * FROM orgs WHERE id = ?', [orgId]);
    const member = org && await db.get('SELECT * FROM memberships WHERE user_id = ? AND org_id = ? AND active = 1', [req.user.id, orgId]);
    if (!org || (!member && !req.user.is_owner)) throw bad('You are not a member of that organization.');
    if (org.status !== 'active' && !req.user.is_owner) throw bad('That organization is suspended.');
    await db.update('sessions', { id: req.session.id }, { org_id: orgId });
    await db.update('users', { id: req.user.id }, { last_org_id: orgId });
    res.json({ ok: true });
  });

  r.get('/notifications', signedIn, async (req, res) => {
    if (!req.org) return res.json([]);
    res.json(await db.all('SELECT * FROM notifications WHERE user_id = ? AND org_id = ? ORDER BY id DESC LIMIT 50', [req.user.id, req.org.id]));
  });

  r.post('/notifications/read', signedIn, async (req, res) => {
    if (req.org) await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND org_id = ? AND read_at IS NULL', [utcNow(), req.user.id, req.org.id]);
    res.json({ ok: true });
  });
};

module.exports.uniqueOrgCode = uniqueOrgCode;
module.exports.sha256 = sha256;
