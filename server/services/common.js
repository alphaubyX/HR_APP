'use strict';

const { utcNow } = require('../lib/dates');
const { orgSettings, policyRules } = require('../engine/policy');
const { notFound } = require('../lib/validate');

async function audit(db, req, action, entity = null, entityId = null, details = null) {
  await db.insert('audit_log', {
    org_id: req.org ? req.org.id : null,
    user_id: req.user ? req.user.id : null,
    action, entity, entity_id: entityId,
    details: details ? JSON.stringify(details).slice(0, 4000) : null,
    ip: req.ip ? String(req.ip).slice(0, 60) : null,
    created_at: utcNow(),
  });
}

/** In-app notification for the sign-in accounts linked to these employees. */
async function notifyEmployees(db, orgId, employeeIds, title, body = null, link = null) {
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (!ids.length) return;
  const rows = await db.all(
    `SELECT user_id FROM memberships WHERE org_id = ? AND active = 1 AND employee_id IN (${ids.map(() => '?').join(',')})`,
    [orgId, ...ids]);
  await notifyUsers(db, orgId, rows.map((r) => r.user_id), title, body, link);
}

async function notifyUsers(db, orgId, userIds, title, body = null, link = null) {
  const now = utcNow();
  for (const uid of new Set(userIds)) {
    await db.insert('notifications', { org_id: orgId, user_id: uid, title: title.slice(0, 200), body: body ? body.slice(0, 500) : null, link, created_at: now });
  }
}

/** Users holding a permission in an organization (e.g. HR for leave requests nobody else can approve). */
async function usersWithPerm(db, orgId, perm) {
  const { rolesWithPerm } = require('./roles');
  const roles = await rolesWithPerm(db, orgId, perm);
  const rows = await db.all(
    `SELECT m.user_id, m.employee_id FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.active = 1 AND u.active = 1 AND m.role IN (${roles.map(() => '?').join(',')})`,
    [orgId, ...roles]);
  return rows;
}

async function loadOrg(db, orgId) {
  const org = await db.get('SELECT * FROM orgs WHERE id = ?', [orgId]);
  if (!org) throw notFound('Organization');
  org.settings = orgSettings(org.settings);
  return org;
}

/** Attendance policies of an organization keyed by id, plus the default one. */
async function loadPolicies(db, orgId) {
  const rows = await db.all('SELECT * FROM attendance_policies WHERE org_id = ?', [orgId]);
  const byId = new Map(rows.map((p) => [p.id, { ...p, rules: policyRules(p.rules) }]));
  const def = rows.find((p) => p.is_default) || rows[0];
  return { byId, default: def ? byId.get(def.id) : { id: null, name: 'Default', rules: policyRules({}) } };
}

async function loadShifts(db, orgId) {
  const rows = await db.all('SELECT * FROM shifts WHERE org_id = ?', [orgId]);
  const byId = new Map(rows.map((s) => [s.id, s]));
  const def = rows.find((s) => s.is_default) || rows[0]
    || { id: null, name: 'Default', start_time: '09:00', end_time: '18:00', break_minutes: 60, weekly_off: '6,7', day_overrides: null };
  return { byId, default: def };
}

/** id → manager_id for the organization's current employees. */
async function managerMap(db, orgId) {
  const rows = await db.all("SELECT id, manager_id FROM employees WHERE org_id = ? AND status <> 'exited'", [orgId]);
  return new Map(rows.map((r) => [r.id, r.manager_id]));
}

/** Everyone below an employee in the organogram (not including them). */
function descendants(map, rootId) {
  const children = new Map();
  for (const [id, mgr] of map) {
    if (!mgr) continue;
    if (!children.has(mgr)) children.set(mgr, []);
    children.get(mgr).push(id);
  }
  const out = new Set();
  const stack = [...(children.get(rootId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) || []));
  }
  return out;
}

/** The chain of managers above an employee, nearest first. */
function managersAbove(map, id, limit = 20) {
  const out = [];
  let cur = map.get(id);
  const seen = new Set([id]);
  while (cur && !seen.has(cur) && out.length < limit) {
    out.push(cur);
    seen.add(cur);
    cur = map.get(cur);
  }
  return out;
}

/**
 * Which employees the signed-in person may see: everyone (with the permission), or themselves and
 * the people below them in the organogram.
 */
async function employeeScope(req, perm = 'employees.view') {
  if (req.perms.has(perm)) return { all: true, ids: null, team: null };
  const self = req.member.employee_id;
  if (!self) return { all: false, ids: new Set(), team: new Set() };
  const team = descendants(await managerMap(req.db, req.org.id), self);
  return { all: false, ids: new Set([self, ...team]), team };
}

function inScope(scope, employeeId) {
  return scope.all || scope.ids.has(Number(employeeId));
}

async function nextEmpCode(db, org) {
  const prefix = org.settings.employee_code_prefix || '';
  const rows = await db.all('SELECT emp_code FROM employees WHERE org_id = ?', [org.id]);
  let max = 0;
  for (const r of rows) {
    if (!r.emp_code.startsWith(prefix)) continue;
    const n = Number(r.emp_code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function fullName(e) {
  return [e.first_name, e.last_name].filter(Boolean).join(' ');
}

module.exports = {
  audit, notifyEmployees, notifyUsers, usersWithPerm, loadOrg, loadPolicies, loadShifts, managerMap,
  descendants, managersAbove, employeeScope, inScope, nextEmpCode, fullName,
};
