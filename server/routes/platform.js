'use strict';

/** The server owner's view of every organization (subscriber) on this server. */

const { ownerOnly } = require('../lib/auth');
const { pick, bad, notFound } = require('../lib/validate');
const { utcNow } = require('../lib/dates');
const { createOrg } = require('../services/orgSetup');
const { createUser } = require('../services/accounts');
const { uniqueOrgCode } = require('./auth');

module.exports = function platformRoutes(r, { db }) {
  r.get('/platform/orgs', ownerOnly, async (req, res) => {
    res.json(await db.all(
      `SELECT o.id, o.name, o.code, o.plan, o.status, o.max_employees, o.created_at, o.email, o.phone,
        (SELECT COUNT(*) FROM employees e WHERE e.org_id = o.id AND e.status <> 'exited') AS employees,
        (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id AND m.active = 1) AS users
       FROM orgs o ORDER BY o.name`));
  });

  r.post('/platform/orgs', ownerOnly, async (req, res) => {
    const b = pick(req.body, {
      name: ['str', { required: true, max: 150 }], currency: ['str', { max: 8, default: 'PKR' }],
      timezone: ['str', { max: 60, default: 'Asia/Karachi' }], plan: ['str', { max: 30, default: 'trial' }],
      admin_name: ['str', { max: 150 }], admin_username: ['str', { max: 40 }], admin_email: ['email'],
    });
    const orgId = await createOrg(db, { name: b.name, code: await uniqueOrgCode(db, b.name), currency: b.currency, timezone: b.timezone, plan: b.plan });
    if (b.admin_username) {
      const userId = await createUser(db, { username: b.admin_username, name: b.admin_name || b.admin_username, email: b.admin_email, password: req.body.admin_password });
      await db.insert('memberships', { user_id: userId, org_id: orgId, role: 'admin', created_at: utcNow() });
    }
    // the owner can always open it; also make them a member so it shows in the switcher
    if (!(await db.get('SELECT id FROM memberships WHERE user_id = ? AND org_id = ?', [req.user.id, orgId]))) {
      await db.insert('memberships', { user_id: req.user.id, org_id: orgId, role: 'admin', created_at: utcNow() });
    }
    res.json({ id: orgId });
  });

  r.put('/platform/orgs/:id', ownerOnly, async (req, res) => {
    const org = await db.get('SELECT * FROM orgs WHERE id = ?', [req.params.id]);
    if (!org) throw notFound('Organization');
    const b = pick(req.body, {
      plan: ['str', { max: 30 }], status: ['str', { oneOf: ['active', 'suspended'] }], max_employees: ['int', { min: 0, max: 1000000 }],
    }, { partial: true });
    if (!Object.keys(b).length) throw bad('Nothing to change.');
    await db.update('orgs', { id: org.id }, b);
    res.json({ ok: true });
  });

  /** The product logos (Broadwing's original artwork), used by every organization. */
  r.put('/platform/brand/:slot', ownerOnly, async (req, res) => {
    const { saveBrand } = require('../services/brand');
    await saveBrand(db, req.params.slot, req.body && req.body.data ? String(req.body.data) : null);
    res.json({ ok: true });
  });
};
