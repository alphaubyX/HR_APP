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
 * Roles inside an organization. Line managers aren't a role: anyone with people under them in the
 * organogram can see their team and approve their requests.
 */
const PERMISSIONS = [
  'org.manage', 'users.manage', 'employees.view', 'employees.edit', 'salary.view', 'salary.edit',
  'attendance.view', 'attendance.manage', 'leave.view', 'leave.manage', 'payroll.view', 'payroll.run',
  'payroll.approve', 'reports.view',
];

const ROLES = {
  admin: { label: 'Administrator', perms: PERMISSIONS },
  hr: {
    label: 'HR manager',
    perms: ['org.manage', 'employees.view', 'employees.edit', 'salary.view', 'attendance.view', 'attendance.manage',
      'leave.view', 'leave.manage', 'payroll.view', 'reports.view', 'users.manage'],
  },
  payroll: {
    label: 'Payroll officer',
    perms: ['employees.view', 'salary.view', 'salary.edit', 'attendance.view', 'leave.view', 'payroll.view', 'payroll.run', 'reports.view'],
  },
  employee: { label: 'Employee (self-service)', perms: [] },
};

function permsFor(role) {
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

module.exports = { inOrg, ownerOnly, hashPassword, verifyPassword, sha256, newToken, ROLES, PERMISSIONS, permsFor, need };
