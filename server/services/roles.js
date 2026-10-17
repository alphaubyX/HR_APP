'use strict';

/**
 * Roles of an organization, kept in the database so each organization can change the rights of
 * the starting roles and add its own. Administrator always has every right, so nobody can lock
 * the organization out of its own settings.
 */

const { ROLES, PERMISSIONS, permsFor } = require('../lib/auth');
const { utcNow } = require('../lib/dates');

/** Add any starting role the organization doesn't have yet (safe to run again). */
async function seedRoles(db, orgId) {
  const have = new Set((await db.all('SELECT role_key FROM roles WHERE org_id = ?', [orgId])).map((r) => r.role_key));
  let sort = 0;
  for (const [key, r] of Object.entries(ROLES)) {
    sort += 10;
    if (have.has(key)) continue;
    await db.insert('roles', {
      org_id: orgId, role_key: key, name: r.label, description: r.description, perms: JSON.stringify(r.perms), is_system: 1, sort, created_at: utcNow(),
    });
  }
}

async function loadRoles(db, orgId) {
  return (await db.all('SELECT * FROM roles WHERE org_id = ? ORDER BY sort, name', [orgId])).map(roleOut);
}

function roleOut(r) {
  return { ...r, is_system: !!r.is_system, locked: r.role_key === 'admin', perms: [...permsFor(r)] };
}

/** Rights and display name of a role key in an organization (built-in defaults if the row is missing). */
async function roleInfo(db, orgId, key) {
  const row = await db.get('SELECT * FROM roles WHERE org_id = ? AND role_key = ?', [orgId, key]);
  if (row) return { name: row.name, perms: permsFor(row) };
  const def = ROLES[key] || ROLES.employee;
  return { name: def.label, perms: permsFor(key in ROLES ? key : 'employee') };
}

/** Role keys in an organization that hold a right. */
async function rolesWithPerm(db, orgId, perm) {
  const rows = await db.all('SELECT * FROM roles WHERE org_id = ?', [orgId]);
  const keys = rows.filter((r) => permsFor(r).has(perm)).map((r) => r.role_key);
  if (!rows.length) return Object.entries(ROLES).filter(([, r]) => r.perms.includes(perm)).map(([k]) => k);
  if (!keys.includes('admin')) keys.push('admin');
  return keys;
}

/**
 * May this person give someone the role? It must exist, only administrators make administrators,
 * and nobody hands out a right they don't have themselves.
 */
async function checkRoleAssign(db, req, key) {
  const { bad } = require('../lib/validate');
  const row = await db.get('SELECT * FROM roles WHERE org_id = ? AND role_key = ?', [req.org.id, key]);
  if (!row && !(key in ROLES)) throw bad('Unknown role.');
  if (req.member.role === 'admin') return;
  if (key === 'admin') throw bad('Only an administrator can make someone an administrator.');
  const perms = row ? permsFor(row) : permsFor(key);
  const missing = [...perms].filter((p) => !req.perms.has(p));
  if (missing.length) throw bad(`That role has rights you don't have yourself (${missing.join(', ')}). Ask an administrator.`);
}

const cleanPerms = (list) => [...new Set((Array.isArray(list) ? list : []).filter((p) => PERMISSIONS.includes(p)))];

module.exports = { seedRoles, loadRoles, roleInfo, rolesWithPerm, roleOut, cleanPerms, checkRoleAssign };
