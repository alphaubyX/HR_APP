// One payroll month: process, review payslips, approve, pay, export.
import { api } from '../api.js';
import { can, navigate } from '../state.js';
import {
  h, icon, pageHead, card, table, reqStatus, money, monthLabel, toast, errorToast, confirmDialog, stat, date, num, alertBox, badge, download, utcToLocal, empty,
} from '../ui.js';

export default async function payrollRun(view, params) {
  const run = await api.get(`/api/payroll/runs/${params.id}`);
  const reload = () => navigate(`/payroll/${run.id}`);
  const t = run.totals;
  const act = (label, url, { kind = '', ic = null, confirm = null } = {}) => h('button', {
    class: ['btn', kind],
    onclick: async (e) => {
      if (confirm && !(await confirmDialog(confirm.text, { ok: label, danger: confirm.danger, detail: confirm.detail }))) return;
      e.currentTarget.disabled = true;
      const btn = e.currentTarget;
      const old = btn.innerHTML;
      btn.textContent = 'Working…';
      try { await api.post(url); toast('Done'); reload(); } catch (err) { errorToast(err); btn.disabled = false; btn.innerHTML = old; }
    },
  }, ic ? icon(ic, 16) : null, label);

  const actions = [];
  if (run.slips.length) {
    actions.push(h('button', { class: 'btn', onclick: () => download(`/api/payroll/runs/${run.id}/export?type=register`) }, icon('download', 16), 'Register'));
    actions.push(h('button', { class: 'btn', onclick: () => download(`/api/payroll/runs/${run.id}/export?type=bank`) }, icon('banknote', 16), 'Bank list'));
  }
  if (['draft', 'processed'].includes(run.status) && can('payroll.run')) {
    actions.push(act(run.status === 'draft' ? 'Process payroll' : 'Recalculate', `/api/payroll/runs/${run.id}/process`, { kind: run.status === 'draft' ? 'primary' : '', ic: 'refresh' }));
  }
  if (run.status === 'processed' && can('payroll.approve')) {
    actions.push(act('Approve', `/api/payroll/runs/${run.id}/approve`, { kind: 'primary', ic: 'check', confirm: { text: `Approve the ${monthLabel(run.month)} payroll?`, detail: 'Loan installments are recorded and the payroll is locked. Employees can see their payslips once approved.' } }));
  }
  if (run.status === 'approved' && can('payroll.approve')) {
    actions.push(act('Mark as paid', `/api/payroll/runs/${run.id}/paid`, { kind: 'primary', ic: 'banknote', confirm: { text: 'Mark this payroll as paid?', detail: 'Employees are told their payslip is ready.' } }));
  }
  if (['approved', 'paid'].includes(run.status) && can('payroll.approve')) {
    actions.push(act('Reopen', `/api/payroll/runs/${run.id}/reopen`, { ic: 'edit', confirm: { text: 'Reopen this payroll?', detail: 'Loan installments recorded by it are undone so it can be recalculated.', danger: true } }));
  }
  if (['draft', 'processed'].includes(run.status) && can('payroll.run')) {
    actions.push(h('button', {
      class: 'btn ghost danger', title: 'Delete',
      onclick: async () => { if (!(await confirmDialog('Delete this payroll?', { danger: true, ok: 'Delete' }))) return; await api.del(`/api/payroll/runs/${run.id}`); toast('Deleted'); navigate('/payroll'); },
    }, icon('trash', 16)));
  }

  view.append(pageHead(run.title || `Payroll ${monthLabel(run.month)}`, {
    crumbs: [{ label: 'Payroll', href: '#/payroll' }, { label: monthLabel(run.month) }],
    sub: h('span', { class: 'row wrap' }, reqStatus(run.status), `${date(run.period_start)} – ${date(run.period_end)}`, run.processed_at ? h('span', { class: 'muted' }, `· calculated ${utcToLocal(run.processed_at)}`) : null),
    actions,
  }));

  if (!t) {
    view.append(card(null, empty('Not processed yet', 'Processing reads every employee’s salary, attendance, leave, loans and adjustments for the period, and makes the payslips. You can recalculate as often as you need until you approve.',
      can('payroll.run') ? act('Process payroll', `/api/payroll/runs/${run.id}/process`, { kind: 'primary', ic: 'play' }) : null, 'wallet')));
    return;
  }

  view.append(h('div', { class: 'grid grid-4 mb-16' },
    stat('Employees', t.employees, { ic: 'users' }),
    stat('Total earnings', money(t.earnings), { ic: 'wallet', hint: `Contract gross ${money(t.gross)}` }),
    stat('Deductions', money(t.deductions), { ic: 'percent', color: 'var(--bad)', bg: 'var(--bad-soft)', hint: t.tax ? `incl. tax ${money(t.tax)}` : null }),
    stat('Net pay', money(t.net, { symbol: true }), { ic: 'banknote', color: 'var(--ok)', bg: 'var(--ok-soft)', hint: t.employer ? `Employer contributions ${money(t.employer)}` : null })));
  if (t.warnings) view.append(h('div', { class: 'mb-16' }, alertBox(`${t.warnings} payslip(s) have something to check — look for the ⚠ sign.`, 'warn', 'alert')));
  if (run.status === 'processed') view.append(h('div', { class: 'mb-16' }, alertBox(h('span', null, 'Need a bonus, fine or arrears? Add it under ', h('a', { href: `#/money/adjustments?month=${run.month}` }, 'Loans & adjustments'), ', then Recalculate. Changing attendance or leave? Recalculate afterwards too.'), 'info', 'info')));

  const holdable = run.status === 'processed' && can('payroll.run');
  view.append(card(null, table({
    rows: run.slips, search: 'Search employee…', pageSize: 100,
    onRow: (s) => navigate(`/payslips/${s.id}`),
    footer: (rows) => h('tr', null, h('td', null, `${rows.length} payslips`), h('td'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, money(rows.reduce((a, s) => a + s.earnings, 0))),
      h('td', { class: 'num' }, money(rows.reduce((a, s) => a + s.deductions, 0))), h('td', { class: 'num' }, money(rows.reduce((a, s) => a + s.net, 0))), h('td')),
    columns: [
      { key: 'name', label: 'Employee', sort: (s) => s.info.name, text: (s) => `${s.info.name} ${s.info.emp_code}`, render: (s) => h('div', null, h('div', { class: 'strong' }, s.info.name), h('div', { class: 'tiny muted' }, [s.info.emp_code, s.info.department].filter(Boolean).join(' · '))) },
      { key: 'days', label: 'Paid days', num: true, sort: (s) => s.employed_days - s.unpaid_days, render: (s) => h('span', { title: `Employed ${s.employed_days} of ${s.period_days} days · ${num(s.unpaid_days)} unpaid` }, `${num(s.employed_days - s.unpaid_days)} / ${num(s.period_days)}`) },
      { key: 'absent_days', label: 'Absent', num: true, sort: true, render: (s) => (s.absent_days ? num(s.absent_days) : '—') },
      { key: 'late_count', label: 'Lates', num: true, sort: true, render: (s) => (s.late_count ? `${s.late_count}${s.late_deduction_days ? ` (−${num(s.late_deduction_days)}d)` : ''}` : '—') },
      { key: 'overtime_hours', label: 'OT h', num: true, sort: true, className: 'hide-sm', render: (s) => (s.overtime_hours ? num(s.overtime_hours) : '—') },
      { key: 'earnings', label: 'Earnings', num: true, sort: true, render: (s) => money(s.earnings) },
      { key: 'deductions', label: 'Deductions', num: true, sort: true, render: (s) => money(s.deductions) },
      { key: 'net', label: 'Net pay', num: true, sort: true, render: (s) => h('strong', null, money(s.net)) },
      {
        key: 'flags', label: '', render: (s) => h('div', { class: 'row gap-4' },
          s.warnings.length ? h('span', { class: 'badge warn', title: s.warnings.join('\n') }, icon('alert', 12), s.warnings.length) : null,
          s.on_hold ? badge('On hold', 'bad') : null,
          holdable ? h('button', { class: 'btn xs', onclick: async () => { await api.put(`/api/payslips/${s.id}/hold`, { on_hold: !s.on_hold }); reload(); } }, s.on_hold ? 'Release' : 'Hold') : null),
      },
    ],
  }), { flush: true }));
}
