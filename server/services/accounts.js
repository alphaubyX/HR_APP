'use strict';

const { hashPassword, verifyPassword, sha256, newToken } = require('../lib/auth');
const { utcNow, utcPlus } = require('../lib/dates');
const { bad } = require('../lib/validate');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

function cleanUsername(u) {
  const s = String(u || '').trim().toLowerCase();
  if (!USERNAME_RE.test(s)) throw bad('Username: 3 to 40 letters, numbers, dots, dashes or underscores.');
  return s;
}

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw bad('Password must be at least 8 characters.');
  if (p.length > 200) throw bad('Password is too long.');
  return p;
}

async function createUser(db, { username, name, email = null, password, isOwner = false }) {
  const uname = cleanUsername(username);
  if (await db.get('SELECT id FROM users WHERE username = ?', [uname])) throw bad('That username is taken.');
  return db.insert('users', {
    username: uname, name: String(name || uname).slice(0, 150), email, password_hash: hashPassword(checkPassword(password)),
    is_owner: isOwner ? 1 : 0, active: 1, created_at: utcNow(),
  });
}

async function startSession(db, userId, orgId, kind, userAgent, days) {
  const token = newToken();
  await db.insert('sessions', {
    token_hash: sha256(token), user_id: userId, org_id: orgId, kind, user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    expires_at: utcPlus(days * 86400000), created_at: utcNow(),
  });
  await db.update('users', { id: userId }, { last_login_at: utcNow(), ...(orgId ? { last_org_id: orgId } : {}) });
  return token;
}

/** The organization to open after sign-in: the last one used, else the first membership. */
async function defaultOrg(db, user) {
  const rows = await db.all(
    `SELECT m.org_id FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND m.active = 1 AND o.status = 'active' ORDER BY m.id`,
    [user.id]);
  if (user.last_org_id && rows.some((r) => r.org_id === user.last_org_id)) return user.last_org_id;
  if (rows.length) return rows[0].org_id;
  if (user.is_owner) {
    const any = await db.get('SELECT id FROM orgs ORDER BY id LIMIT 1');
    return any ? any.id : null;
  }
  return null;
}

/** Create (or, with resetPassword, reset) the server owner from environment variables. */
async function ensureOwner(db, owner) {
  if (!owner || !owner.username || !owner.password) return null;
  const uname = cleanUsername(owner.username);
  const existing = await db.get('SELECT * FROM users WHERE username = ?', [uname]);
  if (!existing) {
    await createUser(db, { username: uname, name: owner.name || uname, password: owner.password, isOwner: true });
    return `Created the owner account "${uname}".`;
  }
  const changes = {};
  if (!existing.is_owner) changes.is_owner = 1;
  if (owner.resetPassword && !verifyPassword(owner.password, existing.password_hash)) {
    changes.password_hash = hashPassword(checkPassword(owner.password));
    changes.active = 1;
  }
  if (Object.keys(changes).length) await db.update('users', { id: existing.id }, changes);
  return changes.password_hash ? `Reset the password of the owner account "${uname}".` : null;
}

module.exports = { cleanUsername, checkPassword, createUser, startSession, defaultOrg, ensureOwner, USERNAME_RE };
