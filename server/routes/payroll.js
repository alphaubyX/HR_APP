'use strict';

const { need, inOrg } = require('../lib/auth');
const { pick, bad, notFound, forbidden } = require('../lib/validate');
const { utcNow, payPeriod } = require('../lib/dates');
const { processRun, approveRun, reopenRun } = require('../services/payroll');
const { audit, notifyEmployees, loadOrg } = require('../services/common');

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

module.exports = function payrollRoutes(r, { db }) {
  async function loadRun(req, id) {
    const run = await db.get('SELECT * FROM payroll_runs WHERE id = ? AND org_id = ?', [id, req.org.id]);
    if (!run) throw notFound('Payroll');
    run.totals = run.totals ? JSON.parse(run.totals) : null;
    return run;
  }

  r.get('/payroll/runs', need('payroll.view'), async (req, res) => {
    const rows = await db.all('SELECT * FROM payroll_runs WHERE org_id = ? ORDER BY month DESC', [req.org.id]);
    res.json(rows.map((x) => ({ ...x, totals: x.totals ? JSON.parse(x.totals) : null })));
  });

  r.post('/payroll/runs', need('payroll.run'), async (req, res) => {
    const b = pick(req.body, { month: ['month', { required: true }], title: ['str', { max: 150 }], notes: ['str', { max: 500 }] });
    if (await db.get('SELECT id FROM payroll_runs WHERE org_id = ? AND month = ?', [req.org.id, b.month])) throw bad(`There is already a payroll for ${b.month}.`);
    const { start, end } = payPeriod(b.month, req.org.settings.payroll_period_start_day);
    const id = await db.insert('payroll_runs', {
      org_id: req.org.id, month: b.month, period_start: start, period_end: end, status: 'draft', title: b.title || null, notes: b.notes || null,
      created_by: req.user.id, created_at: utcNow(),
    });
    await audit(db, req, 'payroll.create', 'payroll_runs', id, b);
    res.json({ id });
  });

  r.get('/payroll/runs/:id', need('payroll.view'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    const slips = await db.all('SELECT * FROM payslips WHERE run_id = ? ORDER BY id', [run.id]);
    res.json({
      ...run,
      slips: slips.map((s) => ({ ...s, info: JSON.parse(s.info || '{}'), warnings: s.warnings ? JSON.parse(s.warnings) : [] })),
    });
  });

  r.post('/payroll/runs/:id/process', need('payroll.run'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    const totals = await processRun(db, req.org.id, run.id);
    await audit(db, req, 'payroll.process', 'payroll_runs', run.id, totals);
    res.json(totals);
  });

  r.post('/payroll/runs/:id/approve', need('payroll.approve'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    await approveRun(db, await loadOrg(db, req.org.id), run, req.user.id);
    await audit(db, req, 'payroll.approve', 'payroll_runs', run.id);
    res.json({ ok: true });
  });

  r.post('/payroll/runs/:id/reopen', need('payroll.approve'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    await reopenRun(db, await loadOrg(db, req.org.id), run);
    await audit(db, req, 'payroll.reopen', 'payroll_runs', run.id);
    res.json({ ok: true });
  });

  r.post('/payroll/runs/:id/paid', need('payroll.approve'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    if (run.status !== 'approved') throw bad('Approve the payroll before marking it paid.');
    await db.update('payroll_runs', { id: run.id }, { status: 'paid', paid_at: utcNow() });
    const slips = await db.all('SELECT employee_id FROM payslips WHERE run_id = ? AND on_hold = 0', [run.id]);
    await notifyEmployees(db, req.org.id, slips.map((s) => s.employee_id), `Your payslip for ${run.month} is ready`, null, '#/me/payslips');
    await audit(db, req, 'payroll.paid', 'payroll_runs', run.id);
    res.json({ ok: true });
  });

  r.delete('/payroll/runs/:id', need('payroll.run'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    if (!['draft', 'processed'].includes(run.status)) throw bad('An approved payroll cannot be deleted. Reopen it first.');
    await db.tx(async (t) => {
      const ids = (await t.all('SELECT id FROM payslips WHERE run_id = ?', [run.id])).map((s) => s.id);
      if (ids.length) await t.run(`DELETE FROM payslip_lines WHERE payslip_id IN (${ids.map(() => '?').join(',')})`, ids);
      await t.run('DELETE FROM payslips WHERE run_id = ?', [run.id]);
      await t.run('DELETE FROM payroll_runs WHERE id = ?', [run.id]);
    });
    await audit(db, req, 'payroll.delete', 'payroll_runs', run.id, { month: run.month });
    res.json({ ok: true });
  });

  r.put('/payslips/:id/hold', need('payroll.run'), async (req, res) => {
    const s = await db.get('SELECT p.*, r.status AS run_status FROM payslips p JOIN payroll_runs r ON r.id = p.run_id WHERE p.id = ? AND p.org_id = ?', [req.params.id, req.org.id]);
    if (!s) throw notFound('Payslip');
    if (s.run_status !== 'processed') throw bad('Payslips can be held only before the payroll is approved.');
    await db.update('payslips', { id: s.id }, { on_hold: req.body?.on_hold ? 1 : 0 });
    res.json({ ok: true });
  });

  async function slipPayload(slip) {
    const lines = await db.all('SELECT * FROM payslip_lines WHERE payslip_id = ? ORDER BY sort, id', [slip.id]);
    const run = await db.get('SELECT id, month, period_start, period_end, status, paid_at FROM payroll_runs WHERE id = ?', [slip.run_id]);
    const org = await db.get('SELECT name, legal_name, address, logo, currency, phone, email FROM orgs WHERE id = ?', [slip.org_id]);
    return { ...slip, info: JSON.parse(slip.info || '{}'), warnings: slip.warnings ? JSON.parse(slip.warnings) : [], lines, run, org };
  }

  r.get('/payslips/:id', inOrg, async (req, res) => {
    const slip = await db.get('SELECT * FROM payslips WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!slip) throw notFound('Payslip');
    if (!req.perms.has('payroll.view')) {
      if (slip.employee_id !== req.member.employee_id) throw forbidden();
      const run = await db.get('SELECT status FROM payroll_runs WHERE id = ?', [slip.run_id]);
      if (!['approved', 'paid'].includes(run.status) || slip.on_hold) throw forbidden('This payslip is not released yet.');
    }
    res.json(await slipPayload(slip));
  });

  r.get('/me/payslips', inOrg, async (req, res) => {
    res.json(await db.all(
      `SELECT p.id, p.net, p.earnings, p.deductions, r.month, r.status, r.paid_at FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
       WHERE p.org_id = ? AND p.employee_id = ? AND r.status IN ('approved', 'paid') AND p.on_hold = 0 ORDER BY r.month DESC`,
      [req.org.id, req.member.employee_id || 0]));
  });

  /** Payroll register (every line as a column) or bank transfer list, as CSV for Excel. */
  r.get('/payroll/runs/:id/export', need('payroll.view'), async (req, res) => {
    const run = await loadRun(req, req.params.id);
    const slips = await db.all('SELECT * FROM payslips WHERE run_id = ? ORDER BY id', [run.id]);
    const type = req.query.type === 'bank' ? 'bank' : 'register';
    let rows;
    if (type === 'bank') {
      rows = [['Employee code', 'Name', 'Bank', 'Account title', 'Account number', 'IBAN', 'Net pay', 'Payment method']];
      for (const s of slips) {
        if (s.on_hold) continue;
        const i = JSON.parse(s.info || '{}');
        rows.push([i.emp_code, i.name, i.bank_name, i.bank_account_title, i.bank_account_no, i.bank_iban, s.net, i.payment_method]);
      }
    } else {
      const lines = slips.length ? await db.all(`SELECT * FROM payslip_lines WHERE payslip_id IN (${slips.map(() => '?').join(',')}) ORDER BY sort`, slips.map((s) => s.id)) : [];
      const label = (l) => (l.source === 'component' ? l.name : { attendance: 'Absence deduction', late: 'Late deduction', overtime: 'Overtime', loan: 'Loan / advance', tax: 'Income tax', adjustment: l.name }[l.source] || l.name);
      const earningCols = [...new Set(lines.filter((l) => l.kind === 'earning').map(label))];
      const deductionCols = [...new Set(lines.filter((l) => l.kind === 'deduction').map(label))];
      rows = [['Employee code', 'Name', 'Department', 'Designation', 'Days employed', 'Present', 'Paid leave', 'Absent', 'Lates', 'Unpaid days', 'OT hours',
        ...earningCols, 'Total earnings', ...deductionCols, 'Total deductions', 'Net pay', 'On hold']];
      for (const s of slips) {
        const i = JSON.parse(s.info || '{}');
        const mine = lines.filter((l) => l.payslip_id === s.id);
        const sumBy = (kind, col) => mine.filter((l) => l.kind === kind && label(l) === col).reduce((a, l) => a + Number(l.amount), 0) || '';
        rows.push([i.emp_code, i.name, i.department, i.designation, s.employed_days, s.present_days, s.paid_leave_days, s.absent_days, s.late_count, s.unpaid_days, s.overtime_hours,
          ...earningCols.map((c) => sumBy('earning', c)), s.earnings, ...deductionCols.map((c) => sumBy('deduction', c)), s.deductions, s.net, s.on_hold ? 'yes' : '']);
      }
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="payroll-${run.month}-${type}.csv"`);
    res.send(`﻿${csv(rows)}`);
  });
};

module.exports.csv = csv;
