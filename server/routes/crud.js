'use strict';

/**
 * List / create / update / delete for simple organization-owned tables (branches, departments,
 * shifts …). Every query is scoped to the signed-in organization.
 */

const { need, inOrg } = require('../lib/auth');
const { pick, notFound } = require('../lib/validate');
const { audit } = require('../services/common');
const { utcNow } = require('../lib/dates');

function crud(r, db, {
  path, table, spec, perm, viewPerm = null, order = 'id', label = 'Item', hasCreatedAt = false,
  beforeSave = null, beforeDelete = null, afterSave = null, decorate = null, listWhere = null,
}) {
  // viewPerm: 'member' = anyone in the organization, a permission name, or (default) the edit permission
  const view = viewPerm === 'member' ? inOrg : need(viewPerm || perm);

  r.get(`/${path}`, view, async (req, res) => {
    let sql = `SELECT * FROM ${table} WHERE org_id = ?`;
    const params = [req.org.id];
    if (listWhere) { const [w, p] = listWhere(req); if (w) { sql += ` AND ${w}`; params.push(...p); } }
    const rows = await db.all(`${sql} ORDER BY ${order}`, params);
    res.json(decorate ? rows.map(decorate) : rows);
  });

  r.post(`/${path}`, need(perm), async (req, res) => {
    const data = pick(req.body, spec);
    if (beforeSave) await beforeSave(req, data, null);
    const row = { ...data, org_id: req.org.id };
    if (hasCreatedAt) row.created_at = utcNow();
    const id = await db.insert(table, row);
    if (afterSave) await afterSave(req, id, data);
    await audit(db, req, `${table}.create`, table, id, data);
    res.json({ id });
  });

  r.put(`/${path}/:id`, need(perm), async (req, res) => {
    const existing = await db.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`, [req.params.id, req.org.id]);
    if (!existing) throw notFound(label);
    const data = pick(req.body, spec, { partial: true });
    if (beforeSave) await beforeSave(req, data, existing);
    await db.update(table, { id: existing.id, org_id: req.org.id }, data);
    if (afterSave) await afterSave(req, existing.id, data, existing);
    await audit(db, req, `${table}.update`, table, existing.id, data);
    res.json({ ok: true });
  });

  r.delete(`/${path}/:id`, need(perm), async (req, res) => {
    const existing = await db.get(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`, [req.params.id, req.org.id]);
    if (!existing) throw notFound(label);
    if (beforeDelete) await beforeDelete(req, existing);
    await db.run(`DELETE FROM ${table} WHERE id = ? AND org_id = ?`, [existing.id, req.org.id]);
    await audit(db, req, `${table}.delete`, table, existing.id, existing.name ? { name: existing.name } : null);
    res.json({ ok: true });
  });
}

module.exports = { crud };
