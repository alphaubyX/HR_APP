'use strict';

const { need, inOrg } = require('../lib/auth');
const { pick, bad, notFound, forbidden } = require('../lib/validate');
const { utcNow, nowIn } = require('../lib/dates');
const { computeComponents, checkFormula } = require('../engine/salary');
const { audit, fullName } = require('../services/common');
const { crud } = require('./crud');

const CALCS = ['fixed', 'percent', 'formula', 'remainder'];

module.exports = function salaryRoutes(r, { db }) {
  async function codes(orgId) {
    return (await db.all('SELECT code FROM salary_components WHERE org_id = ?', [orgId])).map((c) => c.code);
  }

  /** Check one line's calc settings against the known component codes. */
  function checkLine(line, known, label) {
    if (!CALCS.includes(line.calc)) throw bad(`${label}: unknown calculation "${line.calc}".`);
    if (line.calc === 'percent') {
      const base = String(line.percent_of || 'GROSS').toUpperCase();
      if (base !== 'GROSS' && !known.includes(base)) throw bad(`${label}: "${base}" is not a component code.`);
      line.percent_of = base;
    }
    if (line.calc === 'formula') {
      const err = checkFormula(String(line.formula || ''), [...known, 'GROSS']);
      if (err) throw bad(`${label}: ${err}`);
    }
  }

  /* ------------------------------------------------------------ components */
  crud(r, db, {
    path: 'salary-components', table: 'salary_components', perm: 'salary.edit', viewPerm: 'salary.view', order: 'sort, id', label: 'Component',
    spec: {
      name: ['str', { required: true, max: 100 }], code: ['str', { required: true, max: 30 }],
      kind: ['str', { oneOf: ['earning', 'deduction', 'employer'], default: 'earning' }],
      calc: ['str', { oneOf: CALCS, default: 'fixed' }], value: ['num', { min: -1e9, max: 1e9, default: 0 }],
      percent_of: ['str', { max: 30 }], formula: ['str', { max: 500 }], taxable: ['bool'], attendance_based: ['bool'],
      prorate: ['bool'], show_on_payslip: ['bool'], sort: ['int', { min: 0, max: 10000, default: 0 }], active: ['bool'],
    },
    async beforeSave(req, data, existing) {
      if (data.code !== undefined) {
        data.code = String(data.code).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(data.code) || data.code === 'GROSS') throw bad('Code: capital letters, numbers and _ (start with a letter). GROSS is reserved.');
      }
      const merged = { ...(existing || {}), ...data };
      const known = (await codes(req.org.id)).filter((c) => !existing || c !== existing.code).concat(merged.code);
      checkLine(merged, known, merged.name);
      if (existing && data.code && data.code !== existing.code) throw bad('A component\'s code cannot change once created (formulas use it). Create a new component instead.');
    },
    async beforeDelete(req, row) {
      const n = Number(await db.value('SELECT COUNT(*) FROM employee_salary_lines WHERE component_id = ?', [row.id]))
        + Number(await db.value('SELECT COUNT(*) FROM payslip_lines WHERE org_id = ? AND ref_id = ? AND source = ?', [req.org.id, row.id, 'component']));
      if (n) throw bad('This component is used in salaries or payslips. Switch it off (untick Active) instead.');
      await db.run('DELETE FROM structure_lines WHERE component_id = ?', [row.id]);
    },
  });

  /* ------------------------------------------------------------ structures */
  r.get('/salary-structures', need('salary.view'), async (req, res) => {
    const rows = await db.all('SELECT * FROM salary_structures WHERE org_id = ? ORDER BY name', [req.org.id]);
    const lines = await db.all(
      `SELECT l.*, c.name, c.code, c.kind FROM structure_lines l JOIN salary_components c ON c.id = l.component_id
       WHERE l.org_id = ? ORDER BY l.sort, l.id`, [req.org.id]);
    res.json(rows.map((s) => ({ ...s, lines: lines.filter((l) => l.structure_id === s.id) })));
  });

  async function saveStructureLines(req, structureId, lines) {
    if (!Array.isArray(lines)) return;
    const comps = await db.all('SELECT id, code, name FROM salary_components WHERE org_id = ?', [req.org.id]);
    const known = comps.map((c) => c.code);
    const clean = lines.map((l, i) => {
      const c = comps.find((x) => x.id === Number(l.component_id));
      if (!c) throw bad('Component not found.');
      const line = { component_id: c.id, calc: l.calc || 'fixed', value: Number(l.value) || 0, percent_of: l.percent_of || null, formula: l.formula || null, sort: i };
      checkLine(line, known, c.name);
      return line;
    });
    await db.tx(async (t) => {
      await t.run('DELETE FROM structure_lines WHERE structure_id = ? AND org_id = ?', [structureId, req.org.id]);
      for (const l of clean) await t.insert('structure_lines', { ...l, org_id: req.org.id, structure_id: structureId });
    });
  }

  r.post('/salary-structures', need('salary.edit'), async (req, res) => {
    const b = pick(req.body, { name: ['str', { required: true, max: 100 }], description: ['str', { max: 300 }] });
    const id = await db.insert('salary_structures', { ...b, org_id: req.org.id });
    await saveStructureLines(req, id, req.body.lines);
    res.json({ id });
  });

  r.put('/salary-structures/:id', need('salary.edit'), async (req, res) => {
    const s = await db.get('SELECT * FROM salary_structures WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!s) throw notFound('Structure');
    const b = pick(req.body, { name: ['str', { required: true, max: 100 }], description: ['str', { max: 300 }], active: ['bool'] }, { partial: true });
    await db.update('salary_structures', { id: s.id }, b);
    await saveStructureLines(req, s.id, req.body.lines);
    res.json({ ok: true });
  });

  r.delete('/salary-structures/:id', need('salary.edit'), async (req, res) => {
    const s = await db.get('SELECT * FROM salary_structures WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!s) throw notFound('Structure');
    await db.run('DELETE FROM structure_lines WHERE structure_id = ?', [s.id]);
    await db.run('DELETE FROM salary_structures WHERE id = ?', [s.id]);
    await db.run('UPDATE grades SET structure_id = NULL WHERE structure_id = ?', [s.id]);
    res.json({ ok: true });
  });

  /* ---------------------------------------------------- employee salaries */
  async function linesFor(req, rawLines) {
    const comps = await db.all('SELECT * FROM salary_components WHERE org_id = ?', [req.org.id]);
    const known = comps.map((c) => c.code);
    return (rawLines || []).map((l) => {
      const c = comps.find((x) => x.id === Number(l.component_id));
      if (!c) throw bad('Component not found.');
      const line = { component_id: c.id, calc: l.calc || c.calc, value: l.value === undefined || l.value === '' ? c.value : Number(l.value) || 0, percent_of: l.percent_of || c.percent_of, formula: l.formula ?? c.formula };
      checkLine(line, known, c.name);
      return { ...line, code: c.code, name: c.name, kind: c.kind, taxable: c.taxable, attendance_based: c.attendance_based, sort: c.sort };
    });
  }

  function totals(computed) {
    const sum = (k) => computed.lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount, 0);
    return { earnings: Math.round(sum('earning') * 100) / 100, deductions: Math.round(sum('deduction') * 100) / 100, employer: Math.round(sum('employer') * 100) / 100 };
  }

  /** Try a salary before saving it: the component amounts it produces. */
  r.post('/salary/preview', need('salary.view'), async (req, res) => {
    const lines = await linesFor(req, req.body.lines);
    const computed = computeComponents(lines, { GROSS: Number(req.body.gross) || 0 });
    res.json({ lines: computed.lines, errors: computed.errors, ...totals(computed) });
  });

  /** Lines a structure would give (to fill the salary form). */
  r.get('/salary-structures/:id/lines', need('salary.view'), async (req, res) => {
    const rows = await db.all(
      `SELECT l.component_id, l.calc, l.value, l.percent_of, l.formula FROM structure_lines l JOIN salary_components c ON c.id = l.component_id
       WHERE l.structure_id = ? AND l.org_id = ? AND c.active = 1 ORDER BY l.sort, l.id`, [req.params.id, req.org.id]);
    res.json(rows);
  });

  r.get('/employees/:id/salary', inOrg, async (req, res) => {
    const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!e) throw notFound('Employee');
    if (!req.perms.has('salary.view') && e.id !== req.member.employee_id) throw forbidden();
    const revisions = await db.all(
      `SELECT s.*, u.name AS user_name, st.name AS structure FROM employee_salaries s LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN salary_structures st ON st.id = s.structure_id WHERE s.employee_id = ? AND s.org_id = ? ORDER BY s.effective_from DESC, s.id DESC`,
      [e.id, req.org.id]);
    const today = nowIn(req.org.timezone).date;
    const out = [];
    for (const rev of revisions) {
      const lines = await db.all(
        `SELECT l.*, c.code, c.name, c.kind, c.taxable, c.attendance_based, c.sort, c.active FROM employee_salary_lines l
         JOIN salary_components c ON c.id = l.component_id WHERE l.salary_id = ? ORDER BY c.sort, c.id`, [rev.id]);
      const computed = computeComponents(lines.filter((l) => l.active), { GROSS: Number(rev.gross) || 0 });
      out.push({ ...rev, lines: computed.lines, errors: computed.errors, ...totals(computed), current: false, future: rev.effective_from > today });
    }
    const current = out.find((x) => !x.future);
    if (current) current.current = true;
    res.json(out);
  });

  r.post('/employees/:id/salary', need('salary.edit'), async (req, res) => {
    const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!e) throw notFound('Employee');
    const b = pick(req.body, {
      effective_from: ['date', { required: true }], gross: ['money', { default: 0 }], structure_id: ['id'], reason: ['str', { max: 200 }],
    });
    const lines = await linesFor(req, req.body.lines);
    if (!lines.length) throw bad('Add at least one salary component.');
    const locked = await db.get(
      "SELECT month FROM payroll_runs WHERE org_id = ? AND status IN ('approved', 'paid') AND period_end >= ? ORDER BY month LIMIT 1", [req.org.id, b.effective_from]);
    if (locked && !req.body.allow_backdated) throw bad(`Payroll for ${locked.month} is already approved. Choose a later date, or reopen that payroll first.`);
    const first = !Number(await db.value('SELECT COUNT(*) FROM employee_salaries WHERE employee_id = ?', [e.id]));
    const id = await db.tx(async (t) => {
      const sid = await t.insert('employee_salaries', { ...b, org_id: req.org.id, employee_id: e.id, user_id: req.user.id, created_at: utcNow() });
      for (const l of lines) {
        await t.insert('employee_salary_lines', { org_id: req.org.id, salary_id: sid, component_id: l.component_id, calc: l.calc, value: l.value, percent_of: l.percent_of, formula: l.formula });
      }
      await t.insert('employee_events', {
        org_id: req.org.id, employee_id: e.id, event: 'salary', event_date: b.effective_from,
        title: first ? 'Salary set' : `Salary revised${b.reason ? `: ${b.reason}` : ''}`, details: JSON.stringify({ gross: b.gross }), user_id: req.user.id, created_at: utcNow(),
      });
      return sid;
    });
    await audit(db, req, 'salary.set', 'employees', e.id, { gross: b.gross, effective_from: b.effective_from, name: fullName(e) });
    res.json({ id });
  });

  r.delete('/salaries/:id', need('salary.edit'), async (req, res) => {
    const s = await db.get('SELECT * FROM employee_salaries WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!s) throw notFound('Salary');
    const used = await db.get(
      "SELECT month FROM payroll_runs WHERE org_id = ? AND status IN ('approved', 'paid') AND period_end >= ? LIMIT 1", [req.org.id, s.effective_from]);
    if (used) throw bad(`This salary was used for the approved payroll of ${used.month}, so it must be kept. Add a new revision instead.`);
    await db.run('DELETE FROM employee_salary_lines WHERE salary_id = ?', [s.id]);
    await db.run('DELETE FROM employee_salaries WHERE id = ?', [s.id]);
    await audit(db, req, 'salary.delete', 'employees', s.employee_id, { effective_from: s.effective_from });
    res.json({ ok: true });
  });

  /** Apply a raise to many people at once: a % or fixed increase of gross from a date. */
  r.post('/salary/bulk-revision', need('salary.edit'), async (req, res) => {
    const b = pick(req.body, {
      effective_from: ['date', { required: true }], percent: ['num', { min: -100, max: 1000 }], amount: ['num', { min: -1e9, max: 1e9 }],
      reason: ['str', { max: 200 }],
    });
    const ids = (req.body.employee_ids || []).map(Number).filter(Boolean);
    if (!ids.length) throw bad('Choose the employees.');
    if (!b.percent && !b.amount) throw bad('Enter a percentage or an amount.');
    let done = 0;
    for (const id of ids) {
      const latest = await db.get('SELECT * FROM employee_salaries WHERE employee_id = ? AND org_id = ? ORDER BY effective_from DESC, id DESC LIMIT 1', [id, req.org.id]);
      if (!latest) continue;
      const lines = await db.all('SELECT * FROM employee_salary_lines WHERE salary_id = ?', [latest.id]);
      const gross = Math.max(0, Math.round((Number(latest.gross) * (1 + (b.percent || 0) / 100) + (b.amount || 0)) * 100) / 100);
      await db.tx(async (t) => {
        const sid = await t.insert('employee_salaries', { org_id: req.org.id, employee_id: id, effective_from: b.effective_from, gross, structure_id: latest.structure_id, reason: b.reason || 'Increment', user_id: req.user.id, created_at: utcNow() });
        for (const l of lines) {
          // fixed amounts grow by the same percentage; percentages and formulas follow the gross
          const value = l.calc === 'fixed' && b.percent ? Math.round(Number(l.value) * (1 + b.percent / 100) * 100) / 100 : l.value;
          await t.insert('employee_salary_lines', { org_id: req.org.id, salary_id: sid, component_id: l.component_id, calc: l.calc, value, percent_of: l.percent_of, formula: l.formula });
        }
        await t.insert('employee_events', { org_id: req.org.id, employee_id: id, event: 'salary', event_date: b.effective_from, title: `Salary revised: ${b.reason || 'increment'}`, details: JSON.stringify({ gross }), user_id: req.user.id, created_at: utcNow() });
      });
      done++;
    }
    await audit(db, req, 'salary.bulk', null, null, { ...b, count: done });
    res.json({ updated: done });
  });

  /* ---------------------------------------------------------------- tax */
  r.get('/tax-slabs', need('salary.view'), async (req, res) => {
    res.json(await db.all('SELECT * FROM tax_slabs WHERE org_id = ? ORDER BY from_amount', [req.org.id]));
  });

  r.put('/tax-slabs', need('salary.edit'), async (req, res) => {
    const slabs = (req.body?.slabs || []).map((s) => pick(s, {
      from_amount: ['money', { required: true }], to_amount: ['money'], fixed_tax: ['money', { default: 0 }], rate: ['num', { min: 0, max: 100, default: 0 }],
    }));
    slabs.sort((a, b) => a.from_amount - b.from_amount);
    for (const s of slabs) if (s.to_amount !== null && s.to_amount <= s.from_amount) throw bad('Each slab\'s "to" amount must be more than its "from" amount.');
    await db.tx(async (t) => {
      await t.run('DELETE FROM tax_slabs WHERE org_id = ?', [req.org.id]);
      for (const s of slabs) await t.insert('tax_slabs', { ...s, org_id: req.org.id });
    });
    await audit(db, req, 'tax.slabs', null, null, { count: slabs.length });
    res.json({ ok: true });
  });

  /* ----------------------------------------------------- loans & advances */
  r.get('/loans', inOrg, async (req, res) => {
    let sql = `SELECT l.*, e.first_name, e.last_name, e.emp_code,
        (SELECT COALESCE(SUM(amount), 0) FROM loan_repayments r WHERE r.loan_id = l.id) AS repaid
      FROM loans l JOIN employees e ON e.id = l.employee_id WHERE l.org_id = ?`;
    const params = [req.org.id];
    if (!req.perms.has('salary.view')) { sql += ' AND l.employee_id = ?'; params.push(req.member.employee_id || 0); } else if (req.query.employee_id) { sql += ' AND l.employee_id = ?'; params.push(Number(req.query.employee_id)); }
    if (req.query.status) { sql += ' AND l.status = ?'; params.push(String(req.query.status)); }
    const rows = await db.all(`${sql} ORDER BY l.id DESC`, params);
    res.json(rows.map((l) => ({ ...l, name: fullName(l), balance: Math.round((Number(l.amount) - Number(l.repaid)) * 100) / 100 })));
  });

  r.post('/loans', need('salary.edit'), async (req, res) => {
    const b = pick(req.body, {
      employee_id: ['id', { required: true }], kind: ['str', { oneOf: ['loan', 'advance'], default: 'loan' }],
      amount: ['money', { required: true }], installment: ['money', { required: true }], start_month: ['month', { required: true }], reason: ['str', { max: 300 }],
    });
    if (!b.amount || !b.installment) throw bad('Amount and monthly installment must be more than 0.');
    if (b.installment > b.amount) b.installment = b.amount;
    if (!(await db.get('SELECT id FROM employees WHERE id = ? AND org_id = ?', [b.employee_id, req.org.id]))) throw bad('Employee not found.');
    const id = await db.insert('loans', { ...b, org_id: req.org.id, status: 'active', user_id: req.user.id, created_at: utcNow() });
    await audit(db, req, 'loans.create', 'loans', id, b);
    res.json({ id });
  });

  r.put('/loans/:id', need('salary.edit'), async (req, res) => {
    const l = await db.get('SELECT * FROM loans WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!l) throw notFound('Loan');
    const b = pick(req.body, { installment: ['money'], status: ['str', { oneOf: ['active', 'closed', 'paused'] }], reason: ['str', { max: 300 }] }, { partial: true });
    await db.update('loans', { id: l.id }, b);
    await audit(db, req, 'loans.update', 'loans', l.id, b);
    res.json({ ok: true });
  });

  r.get('/loans/:id/repayments', inOrg, async (req, res) => {
    const l = await db.get('SELECT * FROM loans WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!l) throw notFound('Loan');
    if (!req.perms.has('salary.view') && l.employee_id !== req.member.employee_id) throw forbidden();
    res.json(await db.all('SELECT * FROM loan_repayments WHERE loan_id = ? ORDER BY month, id', [l.id]));
  });

  /** A repayment outside payroll, e.g. paid back in cash. */
  r.post('/loans/:id/repayments', need('salary.edit'), async (req, res) => {
    const l = await db.get('SELECT * FROM loans WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!l) throw notFound('Loan');
    const b = pick(req.body, { amount: ['money', { required: true }], month: ['month', { required: true }], note: ['str', { max: 200 }] });
    await db.insert('loan_repayments', { ...b, org_id: req.org.id, loan_id: l.id, created_at: utcNow() });
    const repaid = Number(await db.value('SELECT COALESCE(SUM(amount), 0) FROM loan_repayments WHERE loan_id = ?', [l.id]));
    if (repaid >= Number(l.amount) - 0.005) await db.update('loans', { id: l.id }, { status: 'closed' });
    res.json({ ok: true });
  });

  r.delete('/loans/:id', need('salary.edit'), async (req, res) => {
    const l = await db.get('SELECT * FROM loans WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!l) throw notFound('Loan');
    if (Number(await db.value('SELECT COUNT(*) FROM loan_repayments WHERE loan_id = ?', [l.id]))) throw bad('Repayments have been made. Close the loan instead.');
    await db.run('DELETE FROM loans WHERE id = ?', [l.id]);
    res.json({ ok: true });
  });

  /* ------------------------------------------------- one-off adjustments */
  r.get('/adjustments', need('salary.view'), async (req, res) => {
    const month = String(req.query.month || '');
    const rows = await db.all(
      `SELECT a.*, e.first_name, e.last_name, e.emp_code FROM adjustments a JOIN employees e ON e.id = a.employee_id
       WHERE a.org_id = ? ${month ? 'AND a.month = ?' : ''} ORDER BY a.id DESC`, month ? [req.org.id, month] : [req.org.id]);
    res.json(rows.map((a) => ({ ...a, name: fullName(a) })));
  });

  async function monthLocked(orgId, month) {
    return db.get("SELECT id FROM payroll_runs WHERE org_id = ? AND month = ? AND status IN ('approved', 'paid')", [orgId, month]);
  }

  r.post('/adjustments', need('salary.edit'), async (req, res) => {
    const b = pick(req.body, {
      employee_id: ['id', { required: true }], month: ['month', { required: true }], kind: ['str', { oneOf: ['earning', 'deduction'], default: 'earning' }],
      title: ['str', { required: true, max: 150 }], amount: ['money', { required: true }], taxable: ['bool'],
    });
    if (!(await db.get('SELECT id FROM employees WHERE id = ? AND org_id = ?', [b.employee_id, req.org.id]))) throw bad('Employee not found.');
    if (await monthLocked(req.org.id, b.month)) throw bad(`Payroll for ${b.month} is approved. Reopen it first.`);
    const id = await db.insert('adjustments', { ...b, org_id: req.org.id, user_id: req.user.id, created_at: utcNow() });
    await audit(db, req, 'adjustments.create', 'adjustments', id, b);
    res.json({ id });
  });

  r.delete('/adjustments/:id', need('salary.edit'), async (req, res) => {
    const a = await db.get('SELECT * FROM adjustments WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!a) throw notFound('Adjustment');
    if (await monthLocked(req.org.id, a.month)) throw bad(`Payroll for ${a.month} is approved. Reopen it first.`);
    await db.run('DELETE FROM adjustments WHERE id = ?', [a.id]);
    res.json({ ok: true });
  });
};
