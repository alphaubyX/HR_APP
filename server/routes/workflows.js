'use strict';

/** Roles & rights, approval workflows, and the requests waiting for approval. */

const { need, inOrg, PERMISSION_DEFS } = require('../lib/auth');
const { pick, bad, forbidden, notFound } = require('../lib/validate');
const { utcNow } = require('../lib/dates');
const { audit } = require('../services/common');
const { loadRoles, roleOut, cleanPerms } = require('../services/roles');
const wf = require('../services/workflows');

module.exports = function workflowRoutes(r, ctx) {
  const { db } = ctx;

  /* ---------------------------------------------------------------- roles & rights */
  // Changing what a role may do is for administrators only: otherwise someone allowed to give
  // out roles could give their own role every right.
  const adminOnly = (req) => {
    if (req.member.role !== 'admin') throw forbidden('Only an administrator can change roles and their rights.');
  };

  r.get('/roles', need('users.manage', 'workflows.manage'), async (req, res) => {
    const roles = await loadRoles(db, req.org.id);
    const counts = await db.all('SELECT role, COUNT(*) AS n FROM memberships WHERE org_id = ? AND active = 1 GROUP BY role', [req.org.id]);
    const n = new Map(counts.map((c) => [c.role, Number(c.n)]));
    res.json({ roles: roles.map((x) => ({ ...x, members: n.get(x.role_key) || 0 })), permissions: PERMISSION_DEFS, canEdit: req.member.role === 'admin' });
  });

  async function roleKey(orgId, name) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 16) || 'role';
    for (let i = 0; i < 1000; i++) {
      const key = i ? `${base}_${i}` : base;
      if (!(await db.get('SELECT id FROM roles WHERE org_id = ? AND role_key = ?', [orgId, key]))) return key;
    }
    throw bad('Could not make a unique role name.');
  }

  r.post('/roles', need('users.manage'), async (req, res) => {
    adminOnly(req);
    const b = pick(req.body, { name: ['str', { required: true, max: 80 }], description: ['str', { max: 300 }], copy_from: ['str', { max: 20 }] });
    if (await db.get('SELECT id FROM roles WHERE org_id = ? AND name = ?', [req.org.id, b.name])) throw bad('There is already a role with that name.');
    let perms = cleanPerms(req.body?.perms);
    if (b.copy_from && !req.body?.perms) {
      const src = await db.get('SELECT * FROM roles WHERE org_id = ? AND role_key = ?', [req.org.id, b.copy_from]);
      if (src) perms = roleOut(src).perms;
    }
    const sort = Number(await db.value('SELECT MAX(sort) FROM roles WHERE org_id = ?', [req.org.id])) || 0;
    const key = await roleKey(req.org.id, b.name);
    const id = await db.insert('roles', {
      org_id: req.org.id, role_key: key, name: b.name, description: b.description, perms: JSON.stringify(perms), is_system: 0, sort: sort + 10, created_at: utcNow(),
    });
    await audit(db, req, 'roles.create', 'roles', id, { name: b.name, perms });
    res.json({ id, role_key: key });
  });

  r.put('/roles/:id', need('users.manage'), async (req, res) => {
    adminOnly(req);
    const role = await db.get('SELECT * FROM roles WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!role) throw notFound('Role');
    const b = pick(req.body, { name: ['str', { max: 80 }], description: ['str', { max: 300 }] }, { partial: true });
    if (b.name === null) delete b.name;
    if (b.name && await db.get('SELECT id FROM roles WHERE org_id = ? AND name = ? AND id <> ?', [req.org.id, b.name, role.id])) throw bad('There is already a role with that name.');
    if (req.body && 'perms' in req.body) {
      if (role.role_key === 'admin') throw bad('The Administrator role always has every right.');
      b.perms = JSON.stringify(cleanPerms(req.body.perms));
    }
    await db.update('roles', { id: role.id }, b);
    await audit(db, req, 'roles.update', 'roles', role.id, { ...b });
    res.json({ ok: true });
  });

  r.delete('/roles/:id', need('users.manage'), async (req, res) => {
    adminOnly(req);
    const role = await db.get('SELECT * FROM roles WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!role) throw notFound('Role');
    if (role.is_system) throw bad('The starting roles can be changed but not deleted.');
    const n = Number(await db.value('SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = ?', [req.org.id, role.role_key]));
    if (n) throw bad(`${n} ${n === 1 ? 'person has' : 'people have'} this role. Give them another role first.`);
    const inUse = (await db.all('SELECT steps FROM workflows WHERE org_id = ?', [req.org.id])).some((w) => wf.parse(w.steps, []).some((s) => s.role_key === role.role_key));
    if (inUse) throw bad('An approval workflow uses this role. Change the workflow first.');
    await db.run('DELETE FROM roles WHERE id = ?', [role.id]);
    await audit(db, req, 'roles.delete', 'roles', role.id, { name: role.name });
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------- workflows */
  r.get('/workflows', need('workflows.manage'), async (req, res) => {
    const rows = await db.all('SELECT * FROM workflows WHERE org_id = ?', [req.org.id]);
    const roles = await loadRoles(db, req.org.id);
    const users = await db.all(
      `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? AND m.active = 1 AND u.active = 1 ORDER BY u.name`, [req.org.id]);
    res.json({
      actions: wf.ACTIONS.map((a) => ({
        key: a.key, group: a.group, label: a.label, perm: a.perm,
        initiators: roles.filter((x) => x.perms.includes(a.perm)).map((x) => x.name),
      })),
      stepTypes: wf.STEP_TYPES,
      workflows: rows.map((w) => ({ id: w.id, action: w.action, active: !!w.active, steps: wf.parse(w.steps, []), note: w.note, updated_at: w.updated_at })),
      roles: roles.map((x) => ({ role_key: x.role_key, name: x.name })),
      users,
    });
  });

  r.put('/workflows/:action', need('workflows.manage'), async (req, res) => {
    const action = wf.ACTIONS.find((a) => a.key === req.params.action);
    if (!action) throw notFound('Action');
    const steps = wf.cleanSteps(req.body?.steps || []);
    const active = req.body?.active ? 1 : 0;
    if (active && !steps.length) throw bad('Add at least one approver before switching the workflow on.');
    for (const s of steps) {
      if (s.role_key && !(await db.get('SELECT id FROM roles WHERE org_id = ? AND role_key = ?', [req.org.id, s.role_key]))) throw bad('Role not found.');
      if (s.user_id && !(await db.get('SELECT id FROM memberships WHERE org_id = ? AND user_id = ?', [req.org.id, s.user_id]))) throw bad('That person has no access to this organization.');
    }
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
    const data = { active, steps: JSON.stringify(steps), note, updated_at: utcNow() };
    const existing = await db.get('SELECT id FROM workflows WHERE org_id = ? AND action = ?', [req.org.id, action.key]);
    if (existing) await db.update('workflows', { id: existing.id }, data);
    else await db.insert('workflows', { ...data, org_id: req.org.id, action: action.key, created_at: utcNow() });
    await audit(db, req, 'workflows.update', 'workflows', existing ? existing.id : null, { action: action.key, active, steps });
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------- requests */
  // scope: waiting (for me) | sent (by me) | all (needs workflows.manage)
  r.get('/approvals', inOrg, async (req, res) => {
    const scope = req.query.scope || 'waiting';
    let rows;
    if (scope === 'sent') {
      rows = await db.all('SELECT * FROM approval_requests WHERE org_id = ? AND initiator_user_id = ? ORDER BY id DESC LIMIT 200', [req.org.id, req.user.id]);
    } else if (scope === 'all') {
      if (!req.perms.has('workflows.manage')) throw forbidden();
      rows = await db.all('SELECT * FROM approval_requests WHERE org_id = ? ORDER BY id DESC LIMIT 300', [req.org.id]);
    } else {
      rows = (await db.all("SELECT * FROM approval_requests WHERE org_id = ? AND status = 'pending' ORDER BY id", [req.org.id]))
        .filter((x) => { const s = wf.parse(x.steps, [])[x.step]; return s && x.initiator_user_id !== req.user.id && s.approvers.includes(req.user.id); });
    }
    const out = [];
    for (const row of rows) out.push(await wf.present(db, req, row));
    res.json(out);
  });

  r.get('/approvals/:id', inOrg, async (req, res) => {
    const row = await wf.loadRequest(db, req, req.params.id);
    const steps = wf.parse(row.steps, []);
    const mayView = row.initiator_user_id === req.user.id || req.perms.has('workflows.manage') || steps.some((s) => s.approvers.includes(req.user.id));
    if (!mayView) throw forbidden();
    res.json(await wf.present(db, req, row));
  });

  r.post('/approvals/:id/decide', inOrg, async (req, res) => {
    const row = await wf.loadRequest(db, req, req.params.id);
    const comment = req.body?.comment ? String(req.body.comment).slice(0, 500) : null;
    res.json(await wf.decideRequest(ctx, req, row, !!req.body?.approve, comment));
  });

  r.post('/approvals/:id/cancel', inOrg, async (req, res) => {
    const row = await wf.loadRequest(db, req, req.params.id);
    if (row.initiator_user_id !== req.user.id || row.status !== 'pending') throw bad('Only the person who sent a pending request can withdraw it.');
    await db.update('approval_requests', { id: row.id }, { status: 'cancelled', decided_at: utcNow() });
    await audit(db, req, 'approval.cancel', 'approval_requests', row.id);
    res.json({ ok: true });
  });

  /** The rest of a new employee (salary, sign-in, geofences): done after the employee is approved. */
  r.post('/approvals/:id/followups', inOrg, async (req, res) => {
    const row = await wf.loadRequest(db, req, req.params.id);
    if (row.initiator_user_id !== req.user.id || row.status !== 'pending') throw bad('You can only add to your own pending request.');
    const calls = Array.isArray(req.body?.calls) ? req.body.calls : [];
    const clean = calls.map((c) => {
      const method = String(c.method || '').toUpperCase();
      const path = String(c.path || '');
      if (!['POST', 'PUT'].includes(method) || !wf.FOLLOWUPS.some((re) => re.test(path))) throw bad('That follow-up is not allowed.');
      return { method, path, body: c.body && typeof c.body === 'object' ? c.body : {}, label: c.label ? String(c.label).slice(0, 60) : null };
    });
    const all = [...wf.parse(row.followups, []), ...clean].slice(0, 10);
    await db.update('approval_requests', { id: row.id }, { followups: JSON.stringify(all) });
    res.json({ ok: true });
  });
};
