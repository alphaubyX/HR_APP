'use strict';

const crypto = require('node:crypto');
const { forbidden, HttpError } = require('./validate');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Rights that can be given to a role. Line managers aren't a role: anyone with people under them in
 * the organogram can see their team and approve their requests.
 */
const PERMISSION_DEFS = [
  { key: 'org.manage', group: 'Organization', label: 'Company settings: branches, departments, shifts, holidays, leave types' },
  { key: 'users.manage', group: 'Organization', label: 'Give people sign-ins and roles' },
  { key: 'workflows.manage', group: 'Organization', label: 'Set up approval workflows and act on any approval' },
  { key: 'employees.view', group: 'People', label: 'See every employee' },
  { key: 'employees.edit', group: 'People', label: 'Add and change employees, confirm, exit, organogram' },
  { key: 'attendance.view', group: 'Time', label: 'See everyone’s attendance' },
  { key: 'attendance.manage', group: 'Time', label: 'Correct attendance, machines and imports' },
  { key: 'leave.view', group: 'Time', label: 'See everyone’s leave' },
  { key: 'leave.manage', group: 'Time', label: 'Manage leave balances and decide anyone’s leave' },
  { key: 'salary.view', group: 'Pay', label: 'See salaries' },
  { key: 'salary.edit', group: 'Pay', label: 'Change salaries, loans and adjustments' },
  { key: 'payroll.view', group: 'Pay', label: 'See payroll and payslips of everyone' },
  { key: 'payroll.run', group: 'Pay', label: 'Prepare payroll' },
  { key: 'payroll.approve', group: 'Pay', label: 'Approve, reopen and mark payroll paid' },
  { key: 'reports.view', group: 'Insights', label: 'Reports' },
];
const PERMISSIONS = PERMISSION_DEFS.map((p) => p.key);

/** The roles every organization starts with. They can be changed (except Administrator) and more added. */
const ROLES = {
  admin: { label: 'Administrator', description: 'Everything, always.', perms: PERMISSIONS },
  hr: {
    label: 'HR manager',
    description: 'Runs people, time and leave.',
    perms: ['org.manage', 'employees.view', 'employees.edit', 'salary.view', 'attendance.view', 'attendance.manage',
      'leave.view', 'leave.manage', 'payroll.view', 'reports.view', 'users.manage'],
  },
  payroll: {
    label: 'Payroll officer',
    description: 'Salaries and the monthly payroll.',
    perms: ['employees.view', 'salary.view', 'salary.edit', 'attendance.view', 'leave.view', 'payroll.view', 'payroll.run', 'reports.view'],
  },
  employee: { label: 'Employee (self-service)', description: 'Their own attendance, leave and payslips.', perms: [] },
};

/** The rights of a role kept in the database (a roles row), or of a built-in role by key. */
function permsFor(role) {
  if (role === 'admin' || (role && role.role_key === 'admin')) return new Set(PERMISSIONS);
  if (role && typeof role === 'object') {
    let list = [];
    try { list = JSON.parse(role.perms || '[]'); } catch { /* bad JSON: no rights */ }
    return new Set(list.filter((p) => PERMISSIONS.includes(p)));
  }
  return new Set((ROLES[role] || ROLES.employee).perms);
}

/** Express middleware factory: require one of the listed permissions. */
function need(...perms) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.'));
    if (!req.org) return next(forbidden('Choose an organization first.'));
    if (perms.some((p) => req.perms.has(p))) return next();
    return next(forbidden());
  };
}

/** Signed in with an organization open (any role: self-service pages). */
function inOrg(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  if (!req.org) return next(forbidden('Choose an organization first.'));
  next();
}

function ownerOnly(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  if (!req.user.is_owner) return next(forbidden());
  next();
}

module.exports = { inOrg, ownerOnly, hashPassword, verifyPassword, sha256, newToken, ROLES, PERMISSIONS, PERMISSION_DEFS, permsFor, need };
